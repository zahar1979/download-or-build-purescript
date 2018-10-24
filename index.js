'use strict';

const {execFile} = require('child_process');
const {inspect} = require('util');
const {rename} = require('fs');
const {basename, join, resolve} = require('path');

const buildPurescript = require('build-purescript');
const downloadPurescript = require('download-purescript');
const feint = require('feint');
const inspectWithKind = require('inspect-with-kind');
const isPlainObj = require('is-plain-obj');
const Observable = require('zen-observable');
const once = require('once');
const prepareWrite = require('prepare-write');
const spawnStack = require('spawn-stack');
const which = require('which');

const DIR_ERROR = 'Expected a path where the PureScript binary will be installed';

function getPlatformBinName(platform) {
	return `purs${platform === 'win32' ? '.exe' : ''}`;
}

function addId(obj, id) {
	Object.defineProperty(obj, 'id', {
		value: id,
		writable: true
	});
}

const unsupportedOptions = new Set([
	'filter',
	'revision'
]);
const initialBinName = getPlatformBinName(process.platform);

module.exports = function downloadOrBuildPurescript(...args) {
	return new Observable(observer => {
		const argLen = args.length;

		if (argLen !== 1 && argLen !== 2) {
			throw new RangeError(`Expected 1 or 2 arguments (<string>[, <Object>]), but got ${
				argLen === 0 ? 'no' : argLen
			} arguments.`);
		}

		const [dir, options = {}] = args;
		const subscriptions = new Set();
		const stackCheckResult = {
			id: 'check-stack',
			path: 'stack',
			version: ''
		};
		let binaryPathError;

		if (typeof dir !== 'string') {
			throw new TypeError(`${DIR_ERROR}, but got ${inspectWithKind(dir)}.`);
		}

		if (dir.length === 0) {
			throw new Error(`${DIR_ERROR}, but got '' (empty string).`);
		}

		if (argLen === 2) {
			if (!isPlainObj(options)) {
				throw new TypeError(`Expected an object to specify options of install-purescript, but got ${
					inspectWithKind(options)
				}.`);
			}

			if (options.rename !== undefined && typeof options.rename !== 'function') {
				throw new TypeError(`\`rename\` option must be a function, but ${
					inspectWithKind(options.rename)
				} was provided.`);
			}

			for (const optionName of unsupportedOptions) {
				const val = options[optionName];

				if (val !== undefined) {
					throw new Error(`\`${optionName}\` option is not supported, but ${inspect(val)} was provided to it.`);
				}
			}
		}

		const version = options.version || downloadPurescript.defaultVersion;
		const isDifferentPlatform = options.platform && options.platform !== process.platform;
		const buildOptions = {revision: `v${version}`, ...options};

		// to validate build-purescript arguments beforehand
		const tmpSubscription = buildPurescript(__dirname, buildOptions).subscribe({
			error(err) {
				observer.error(err);
			}
		});

		setImmediate(() => tmpSubscription.unsubscribe());

		const defaultBinName = getPlatformBinName(options.platform || process.platform);
		const binName = options.rename ? options.rename(defaultBinName) : defaultBinName;

		if (typeof binName !== 'string') {
			throw new TypeError(`Expected \`rename\` option to be a function that returns a string, but returned ${
				inspectWithKind(binName)
			}.`);
		}

		if (binName.length === 0) {
			throw new Error('Expected `rename` option to be a function that returns a new binary name, but returned \'\' (empty string).');
		}

		const binPath = resolve(dir, binName);

		function sendError(err, id) {
			addId(err, id);
			observer.error(err);
		}

		const startBuild = feint(() => {
			if (stackCheckResult.error) {
				sendError(stackCheckResult.error, 'check-stack');
				return;
			}

			observer.next(stackCheckResult);
			observer.next({id: 'check-stack:complete'});

			subscriptions.add(buildPurescript(dir, buildOptions).subscribe({
				next(progress) {
					if (progress.id === 'build:complete') {
						// No need to check `resolve(dir, initialBinName) !== binPath`, because:
						// > If oldpath and newpath are existing hard links referring to
						// > the same file, then rename() does nothing,
						// > and returns a success status.
						// (http://man7.org/linux/man-pages/man2/rename.2.html#DESCRIPTION)
						rename(resolve(dir, initialBinName), binPath, err => {
							if (err) {
								sendError(err, 'build');
								return;
							}

							observer.next(progress);
							observer.complete();
						});

						return;
					}

					progress.id = progress.id.replace('download', 'download-source');
					observer.next(progress);
				},
				error(err) {
					sendError(err, err.id.replace('download', 'download-source'));
				}
			}));
		});

		const startBuildIfNeeded = () => {
			if (observer.closed) {
				return;
			}

			startBuild();
		};

		which('stack', async (_, stackPath) => {
			stackCheckResult.path = stackPath;

			try {
				stackCheckResult.version = (await spawnStack(['--numeric-version'], options)).stdout;
			} catch (err) {
				stackCheckResult.error = err;
			}

			startBuildIfNeeded();
		});

		function handleBinaryDownloadError(err) {
			addId(err, 'download-binary');

			if (isDifferentPlatform) {
				observer.error(err);
				return;
			}

			observer.next({
				id: 'download-binary:fail',
				error: err
			});

			startBuildIfNeeded();
		}

		const downloadObserver = {
			next(progress) {
				progress.id = 'download-binary';
				observer.next(progress);
			},
			error(err) {
				if (err.code === 'ERR_UNSUPPORTED_PLATFORM' && !isDifferentPlatform) {
					addId(err, 'head');

					observer.next({
						id: 'head:fail',
						error: err
					});

					startBuildIfNeeded();
					return;
				}

				sendError(err, 'head');
			},
			complete() {
				observer.next({id: 'download-binary:complete'});

				if (isDifferentPlatform) {
					observer.complete();
					return;
				}

				observer.next({id: 'check-binary'});

				execFile(binPath, ['--version'], {timeout: 50000, ...options}, (err, stdout, stderr) => {
					if (err) {
						err.message += `\n${stderr}`;
						addId(err, 'check-binary');

						observer.next({
							id: 'check-binary:fail',
							error: err
						});

						startBuildIfNeeded();
						return;
					}

					observer.next({id: 'check-binary:complete'});
					observer.complete();
				});
			}
		};

		const completeHead = once(() => {
			observer.next({id: 'head:complete'});

			if (binaryPathError) {
				sendError(binaryPathError, 'download-binary');
				return;
			}

			downloadObserver.error = handleBinaryDownloadError;
		});

		(async () => {
			try {
				await prepareWrite(binPath);

				if (observer.closed) {
					return;
				}
			} catch (err) {
				binaryPathError = err;

				if (observer.closed) {
					return;
				}

				completeHead();
			}
		})();

		subscriptions.add(downloadPurescript(dir, {
			...options,
			filter(path, entry) {
				completeHead();

				if (basename(path, '.exe') !== 'purs') {
					return false;
				}

				entry.path = `purescript/${binName}`;
				entry.header.path = `purescript/${binName}`;
				entry.absolute = join(dir, binName);

				return true;
			},
			version
		}).subscribe(downloadObserver));

		observer.next({id: 'head'});

		return function cancelBuildOrDownloadPurescript() {
			for (const subscription of subscriptions) {
				subscription.unsubscribe();
			}
		};
	});
};

Object.defineProperty(module.exports, 'defaultVersion', {
	value: downloadPurescript.defaultVersion,
	enumerable: true
});

Object.defineProperty(module.exports, 'supportedBuildFlags', {
	value: buildPurescript.supportedBuildFlags,
	enumerable: true
});

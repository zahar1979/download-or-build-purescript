'use strict';

const {basename, isAbsolute, join} = require('path');
const {createGzip} = require('zlib');
const {createServer} = require('http');
const {EOL} = require('os');
const {execFile} = require('child_process');
const {promisify} = require('util');
const {mkdir} = require('fs').promises;

const downloadOrBuildPurescript = require('.');
const feint = require('feint');
const importFresh = require('import-fresh');
const {pack} = require('tar-stream');
const pretendPlatform = require('pretend-platform');
const rmfr = require('rmfr');
const test = require('tape');
const toExecutableName = require('to-executable-name');

const DEFAULT_NAME = toExecutableName('purs');
const promisifiedExecFile = promisify(execFile);

const server = createServer(({url}, res) => {
	res.statusCode = 200;
	res.setHeader('content-encoding', 'gzip');

	const tar = pack();

	if (url.includes('broken')) {
		tar.entry({name: 'broken/purs'}, 'broken');
		tar.push('broken');
	} else {
		tar.entry({name: 'dir/purs'}, 'not a binary');
	}

	tar.finalize();
	tar.pipe(createGzip()).pipe(res);
}).listen(3018, () => test('downloadOrBuildPurescript()', async t => {
	t.plan(50);

	await rmfr(join(__dirname, 'tmp*'), {glob: true});

	const closeServer = feint(() => server.close());
	const tmpDir = join(__dirname, 'tmp');
	const anotherTmpDir = join(tmpDir, 'built');
	const ids = new Map();

	await mkdir(anotherTmpDir, {recursive: true});
	process.chdir(tmpDir);

	downloadOrBuildPurescript().subscribe({
		next(progress) {
			ids.set(progress.id, progress);
		},
		error: t.fail,
		async complete() {
			const values = ids.values();

			t.deepEqual(
				values.next().value,
				{id: 'head'},
				'should send `head` progress.'
			);

			t.deepEqual(
				values.next().value,
				{id: 'head:complete'},
				'should send `head:complete` progress.'
			);

			const downloadBinary = values.next().value;

			t.equal(
				downloadBinary.id,
				'download-binary',
				'should send `download-binary` progress.'
			);

			t.equal(
				downloadBinary.entry.header.path,
				`purescript/${DEFAULT_NAME}`,
				'should include `entry` property to `download-binary` progress.'
			);

			t.equal(
				downloadBinary.response.headers.server,
				'AmazonS3',
				'should include `response` property to `download-binary` progress.'
			);

			t.equal(
				new URL(downloadBinary.response.url).protocol,
				'https:',
				'should use HTTPS.'
			);

			t.deepEqual(
				values.next().value,
				{id: 'download-binary:complete'},
				'should send `download-binary:complete` progress.'
			);

			t.deepEqual(
				values.next().value,
				{id: 'check-binary'},
				'should send `check-binary` progress.'
			);

			t.deepEqual(
				values.next().value,
				{id: 'check-binary:complete'},
				'should send `check-binary:complete` progress.'
			);

			t.ok(
				values.next().done,
				'should send no progress after the prebuilt binary is successfully downloaded.'
			);

			t.equal(
				(await promisifiedExecFile(join(tmpDir, DEFAULT_NAME), ['--version'])).stdout,
				`0.12.3${EOL}`,
				'should download the binary correctly.'
			);
		}
	});

	const fail = t.fail.bind(t, 'Unexpectedly succeeded.');

	downloadOrBuildPurescript({baseUrl: 'http://localhost:3019'}).subscribe({
		error({code}) {
			t.equal(
				code,
				'ECONNREFUSED',
				'should fail when it cannot connect to the binary server.'
			);
		},
		complete: fail
	});

	downloadOrBuildPurescript({
		baseUrl: 'http://localhost:3018/broken',
		rename: () => 'broken',
		maxBuffer: 1
	}).subscribe({
		next({id, error}) {
			if (id === 'head:complete') {
				t.pass('should fire `head:complete` even if the downloading data is corrupt.');
			}

			if (id === 'download-binary:fail') {
				t.equal(
					error.message,
					'invalid entry',
					'should send `download-binary:fail` progress when it fails to download a binary.'
				);
			}
		},
		error(err) {
			closeServer();

			t.equal(
				err.message,
				'stdout maxBuffer exceeded',
				'should fail when the `stack` command does not work correctly.'
			);

			t.equal(
				err.id,
				'check-stack',
				'should add `check-stack` id to the error when the `stack` command is not available.'
			);
		},
		complete: fail
	});

	downloadOrBuildPurescript({
		baseUrl: 'http://localhost:3018',
		version: '0.11.7',
		rename(originalName) {
			return originalName.replace(DEFAULT_NAME, 'tmpfile');
		}
	}).subscribe({
		next({error, id, path, version}) {
			if (id === 'check-binary:fail') {
				t.ok(
					/spawn .+ (?:EACCES|ENOENT)/u.test(error.message),
					'should send `check-binary:fail` progress when a downloaded binary is broken.'
				);

				return;
			}

			if (id === 'check-stack') {
				t.ok(
					isAbsolute(path),
					'should resolve the absolute path of `stack` binary when the prebuilt binary is broken.'
				);

				t.equal(
					version,
					'1.9.3',
					'should check the version of `stack` command when the prebuilt binary is broken.'
				);

				return;
			}

			if (id === 'download-source:complete') {
				t.pass('should download PureScript source when the prebuilt binary is broken.');
			}
		},
		error(err) {
			closeServer();

			t.ok(
				['setup', 'build'].includes(err.id),
				'should fail when the source code archive is currupt.'
			);
		},
		complete: fail
	});

	downloadOrBuildPurescript({rename: () => basename(anotherTmpDir)}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				`Error: Tried to create a PureScript binary at ${anotherTmpDir}, but a directory already exists there.`,
				'should fail when a directory already exits in the target binary path.'
			);
		}
	});

	pretendPlatform('aix');
	process.chdir(anotherTmpDir);

	const setupOutput = [];
	const nums = Array.from({length: 20}, (v, k) => Math.floor((k + 1) * 7.5));
	const logRegexps = nums.map(num => new RegExp(`^\\[ *${num} of \\d+\\] Compiling (Language|Paths_purescript)`, 'u'));

	downloadOrBuildPurescript({
		args: ['--fast', '--no-test'],
		rename: originalName => `${originalName}.bin`
	}).subscribe({
		async next({entry, error, id, output}) {
			if (id === 'head:fail') {
				t.ok(
					error.message.startsWith('Prebuilt `purs` binary is not provided for '),
					'should send `head:fail` progress when the prebuilt `purs` is not provided for the current platform.'
				);

				return;
			}

			if (id === 'check-stack:complete') {
				t.pass('should check the version of `stack` command when the prebuilt binary is not provided for the current platform.');
				return;
			}

			if (id === 'download-source' && entry.header.path.endsWith('/app/')) {
				t.equal(
					entry.header.type,
					'Directory',
					'should fire the status of each entry in the PureScript source.'
				);

				return;
			}

			if (id === 'download-source:complete') {
				t.pass('should send `download-source:complete` progress when the source is completely downloaded.');
				return;
			}

			if (id === 'setup') {
				setupOutput.push(output);
				return;
			}

			if (id === 'setup:complete') {
				t.ok(
					setupOutput.join('').includes('GHC'),
					'should send the output of `stack setup` log.'
				);
				return;
			}

			if (id === 'build:complete') {
				t.equal(
					(await promisifiedExecFile(join(anotherTmpDir, `${DEFAULT_NAME}.bin`), ['--version'])).stdout,
					`0.12.3${EOL}`,
					'should build the binary when the prebuilt binary is not provided for the current platform.'
				);

				return;
			}

			if (logRegexps.length === 0) {
				return;
			}

			if (typeof output === 'string' && output.endsWith('copy/register')) {
				console.log(`${' '.repeat('ok ** '.length)}${output}`);
			}

			if (logRegexps[0].test(output)) {
				t.pass(`should send the output of \`stack install\` log (${(nums.shift() / (7.5 * 0.2)).toFixed(0)} %).`);
				logRegexps.shift();
			}
		},
		error: t.fail,
		complete() {
			pretendPlatform('sunos');

			downloadOrBuildPurescript({args: ['--dry-run']}).subscribe({
				error({id, message}) {
					t.ok(
						message.includes('no such file or directory, rename'),
						'should rename the binary built with `stack setup`.'
					);

					t.equal(
						id,
						'build',
						'should include `id` property to the error passed to `error` callback.'
					);
				}
			});

			pretendPlatform.restore();
		}
	});

	pretendPlatform.restore();
}));

test('Argument validation', t => {
	t.plan(8);

	downloadOrBuildPurescript(['H', 'i']).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'TypeError: Expected an object to specify options of install-purescript, ' +
        'but got [ \'H\', \'i\' ] (array).',
				'should fail when the second argument is not a plain object.'
			);
		}
	});

	downloadOrBuildPurescript({rename: '\0'}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'TypeError: `rename` option must be a function, but \'\\u0000\' (string) was provided.',
				'should fail when `rename` option is not a function.'
			);
		}
	});

	downloadOrBuildPurescript({rename: originalName => originalName.length}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				`TypeError: Expected \`rename\` option to be a function that returns a string, but returned ${
					DEFAULT_NAME.length
				} (number).`,
				'should fail when `rename` option returns a non-string value.'
			);
		}
	});

	downloadOrBuildPurescript({rename: () => '\0\0'}).subscribe({
		error({code}) {
			t.equal(
				code,
				'ERR_INVALID_ARG_VALUE',
				'should fail when `rename` option returns a string containing null bytes.'
			);
		}
	});

	pretendPlatform('win32');

	importFresh('.')({
		rename(originalName) {
			return originalName.replace('purs.exe', '');
		}
	}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'Error: Expected `rename` option to be a function that returns a new binary name, ' +
        'but returned \'\' (empty string).',
				'should fail when `rename` option returns an empty string.'
			);
		}
	});

	pretendPlatform.restore();

	downloadOrBuildPurescript({args: new Uint16Array()}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'TypeError: Expected `args` option to be an array of user defined arguments ' +
        'passed to `stack setup` and `stack install`, but got a non-array value Uint16Array [].',
				'should fail when it takes an invalid build-purescript option.'
			);
		}
	});

	downloadOrBuildPurescript({filter: NaN}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'Error: `filter` option is not supported, but NaN was provided to it.',
				'should fail when it takes an unsupported option.'
			);
		}
	});

	downloadOrBuildPurescript({}, {}).subscribe({
		error(err) {
			t.equal(
				err.toString(),
				'RangeError: Expected 0 or 1 argument ([<Object>]), but got 2 arguments.',
				'should fail when it takes too many arguments.'
			);
		}
	});
});

test('downloadOrBuildPurescript.supportedBuildFlags', t => {
	t.ok(
		downloadOrBuildPurescript.supportedBuildFlags.has('--fast'),
		'should be a Set of build-only flags.'
	);

	t.throws(() => {
		downloadOrBuildPurescript.supportedBuildFlags = 1;
	}, /Cannot assign to read only property/u, 'should be unoverwritable.');

	t.ok(
		Object.keys(downloadOrBuildPurescript).includes('supportedBuildFlags'),
		'should be enumerable.'
	);

	t.end();
});

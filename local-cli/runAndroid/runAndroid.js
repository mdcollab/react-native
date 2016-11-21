 /**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';

const chalk = require('chalk');
const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const parseCommandLine = require('../util/parseCommandLine');
const isPackagerRunning = require('../util/isPackagerRunning');
const Promise = require('promise');
const adb = require('./adb');

/**
 * Starts the app on a connected Android emulator or device.
 */
function runAndroid(argv, config) {
  return new Promise((resolve, reject) => {
    _runAndroid(argv, config, resolve, reject);
  });
}

function _runAndroid(argv, config, resolve, reject) {
  const args = parseCommandLine([{
    command: 'install-debug',
    type: 'string',
    required: false,
  }, {
    command: 'root',
    type: 'string',
    description: 'Override the root directory for the android build (which contains the android directory)',
  }, {
    command: 'flavor',
    type: 'string',
    required: false,
  }, {
    command: 'variant',
    type: 'string',
    required: false,
  }], argv);

  args.root = args.root || '';

  if (!checkAndroid(args)) {
    console.log(chalk.red('Android project not found. Maybe run react-native android first?'));
    return;
  }

  resolve(isPackagerRunning().then(result => {
    if (result === 'running') {
      console.log(chalk.bold(`JS server already running.`));
    } else if (result === 'unrecognized') {
      console.warn(chalk.yellow(`JS server not recognized, continuing with build...`));
    } else {
      // result == 'not_running'
      console.log(chalk.bold(`Starting JS server...`));
      startServerInNewWindow();
    }
    buildAndRun(args, reject);
  }));
}

// Verifies this is an Android project
function checkAndroid(args) {
  return fs.existsSync(path.join(args.root, 'android/gradlew'));
}

// Builds the app and runs it on a connected emulator / device.
function buildAndRun(args, reject) {
  process.chdir(path.join(args.root, 'android'));
  try {
    const cmd = process.platform.startsWith('win')
      ? 'gradlew.bat'
      : './gradlew';

    const gradleArgs = [];
    if (args['variant']) {
        gradleArgs.push('install' +
          args['variant'][0].toUpperCase() + args['variant'].slice(1)
        );
    } else if (args['flavor']) {
        console.warn(chalk.yellow(
          `--flavor has been deprecated. Use --variant instead`
        ));
        gradleArgs.push('install' +
          args['flavor'][0].toUpperCase() + args['flavor'].slice(1)
        );
    } else {
        gradleArgs.push('installDebug');
    }

    if (args['install-debug']) {
      gradleArgs.push(args['install-debug']);
    }

    console.log(chalk.bold(
      `Building and installing the app on the device (cd android && ${cmd} ${gradleArgs.join(' ')}...`
    ));

    child_process.execFileSync(cmd, gradleArgs, {
      stdio: [process.stdin, process.stdout, process.stderr],
    });
  } catch (e) {
    console.log(chalk.red(
      'Could not install the app on the device, read the error above for details.\n' +
      'Make sure you have an Android emulator running or a device connected and have\n' +
      'set up your Android development environment:\n' +
      'https://facebook.github.io/react-native/docs/android-setup.html'
    ));
    // stderr is automatically piped from the gradle process, so the user
    // should see the error already, there is no need to do
    // `console.log(e.stderr)`
    reject();
    return;
  }

  try {
    const activityClass = 'MainActivity';

    //Find the generated manifest file corresponding to the provided variant
    const manifestFile = getManifestFile(args.variant);
    const content = fs.readFileSync(manifestFile, 'utf8');

    //Find the correct package name from the manifest file
    const packageName = content.match(/package="(.+?)"/)[1];

    //Find the correct activityName from the manifestFile
    const activityName = findActivityName(content, activityClass);

    const adbPath = process.env.ANDROID_HOME
      ? process.env.ANDROID_HOME + '/platform-tools/adb'
      : 'adb';

    const devices = adb.getDevices();

    if (devices && devices.length > 0) {
      devices.forEach((device) => {

        const adbArgs = ['-s', device, 'shell', 'am', 'start', '-n',
        `${packageName}/${activityName}`];

        console.log(chalk.bold(
          `Starting the app on ${device} (${adbPath} ${adbArgs.join(' ')})...`
        ));

        child_process.spawnSync(adbPath, adbArgs, {stdio: 'inherit'});
      });
    } else {
      // If we cannot execute based on adb devices output, fall back to
      // shell am start
      const fallbackAdbArgs = [
        'shell', 'am', 'start', '-n', `${packageName}/${activityName}`
      ];
      console.log(chalk.bold(
        `Starting the app (${adbPath} ${fallbackAdbArgs.join(' ')}...`
      ));
      child_process.spawnSync(adbPath, fallbackAdbArgs, {stdio: 'inherit'});
    }

  } catch (e) {
    console.log(chalk.red(
      `adb invocation failed. Do you have adb in your PATH?`
    ));
    // stderr is automatically piped from the gradle process, so the user
    // should see the error already, there is no need to do
    // `console.log(e.stderr)`
    reject();
    return;
  }
}

function startServerInNewWindow() {
  const yargV = require('yargs').argv;
  const scriptFile = /^win/.test(process.platform) ?
    'launchPackager.bat' :
    'launchPackager.command';
  const packagerDir = path.resolve(__dirname, '..', '..', 'packager');
  const launchPackagerScript = path.resolve(packagerDir, scriptFile);
  const procConfig = {cwd: packagerDir};

  if (process.platform === 'darwin') {
    if (yargV.open) {
      return child_process.spawnSync('open', ['-a', yargV.open, launchPackagerScript], procConfig);
    }
    return child_process.spawnSync('open', [launchPackagerScript], procConfig);

  } else if (process.platform === 'linux') {
    procConfig.detached = true;
    if (yargV.open){
      return child_process.spawn(yargV.open,['-e', 'sh', launchPackagerScript], procConfig);
    }
    return child_process.spawn('sh', [launchPackagerScript], procConfig);

  } else if (/^win/.test(process.platform)) {
    procConfig.detached = true;
    procConfig.stdio = 'ignore';
    return child_process.spawn('cmd.exe', ['/C', 'start', launchPackagerScript], procConfig);
  } else {
    console.log(chalk.red(`Cannot start the packager. Unknown platform ${process.platform}`));
  }
}

function findActivityName(content, activityClass) {
  const regex = new RegExp(`android:name="(.+?\.${activityClass})"`);
  return content.match(regex)[1];
}

function findPreviousTerm(content, endPos) {
  while (content[endPos] === ' ') {
    --endPos;
  }
  const regex = new RegExp('\\w');
  const word = [];
  while (regex.exec(content[endPos])) {
    word.push(content[endPos]);
    --endPos;
  }
  return word.reverse().join('');
}

function findVariants(filePath, variantType, defaultVariants) {
  const content = fs.readFileSync(filePath, 'utf8');
  const regex = new RegExp(`${variantType}\\s+{`, 'ig');
  const variants = defaultVariants || [];
  const match = regex.exec(content);
  if (!match) {
    return variants;
  }
  const variantStartPos = regex.lastIndex;
  let counter = 1;
  let pos = variantStartPos + 1;
  while (counter > 0) {
    if (content[pos] === '{') {
      counter += 1;
      if (counter === 2) {
        const previousTerm = findPreviousTerm(content, pos - 1);
        if (variants.indexOf(previousTerm) === -1) {
          variants.push(previousTerm);
        }
      }
    } else if (content[pos] === '}') {
      --counter;
    }
    ++pos;
  }
  return variants;
}

function splitVariant(gradleFilePath, variant) {
  const buildTypes = findVariants(gradleFilePath, 'buildTypes', ['debug', 'release']);
  const regexp = new RegExp(buildTypes.join('|'), 'gi');
  const match = regexp.exec(variant);
  if (match) {
    return [variant.substring(match.index), variant.substring(0, match.index)];
  }
  return [variant, null];
}

function isSeparateBuildEnabled(gradleFilePath) {
  const content = fs.readFileSync(gradleFilePath, 'utf8');
  const separateBuild = content.match(/enableSeparateBuildPerCPUArchitecture\s+=\s+([\w]+)/)[1];
  return separateBuild.toLowerCase() === 'true';
}

function getManifestFile(variant) {
  const gradleFilePath = 'app/build.gradle';
  const ret = splitVariant(gradleFilePath, variant);
  const buildType = ret[0];
  const flavor = ret[1];
  const paths = ['app/build/intermediates/manifests/full'];
  if (flavor) {
    paths.push(flavor);
  }

  if (isSeparateBuildEnabled(gradleFilePath)) {
      paths.push('x86');
  }

  paths.push(buildType);
  paths.push('AndroidManifest.xml');
  return paths.join('/');
}

module.exports = {
  name: 'run-android',
  description: 'builds your app and starts it on a connected Android emulator or device',
  func: runAndroid,
  options: [{
    command: '--install-debug',
  }, {
    command: '--root [string]',
    description: 'Override the root directory for the android build (which contains the android directory)',
    default: '',
  }, {
    command: '--flavor [string]',
    description: '--flavor has been deprecated. Use --variant instead',
  }, {
    command: '--variant [string]',
  }],
};

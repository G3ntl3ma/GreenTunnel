const createWindowsInstaller = require('electron-winstaller').createWindowsInstaller;
const path = require('path');
const fs = require('fs');
const os = require('os');

ensureSevenZip();

getInstallerConfig()
    .then(createWindowsInstaller)
    .catch((error) => {
        console.debug(error.message || error);
        process.exit(1)
    });

// electron-winstaller@5.4.0 ships a broken install script (script/select-7z-arch.js
// uses `os.arch` instead of `os.arch()`), so vendor/7z.exe is never generated and
// Squirrel cannot extract the .nupkg ("system cannot find the file specified").
// Recreate the host-arch 7-Zip helper here so the build is self-contained.
function ensureSevenZip () {
    const vendorDir = path.join(path.dirname(require.resolve('electron-winstaller/package.json')), 'vendor');
    const exe = path.join(vendorDir, '7z.exe');
    const dll = path.join(vendorDir, '7z.dll');
    if (fs.existsSync(exe) && fs.existsSync(dll)) return;

    const arch = os.arch();
    console.log('Preparing 7-Zip for host arch ' + arch);
    fs.copyFileSync(path.join(vendorDir, `7z-${arch}.exe`), exe);
    fs.copyFileSync(path.join(vendorDir, `7z-${arch}.dll`), dll);
}

function getInstallerConfig () {
    console.log('creating windows installer');
    const rootPath = path.join('./');
    const outPath = path.join(rootPath, 'release-builds');

    return Promise.resolve({
        appDirectory: path.join(outPath, 'green-tunnel-win32-x64'),
        authors: 'Sadegh Hayeri',
        noMsi: true,
        outputDirectory: path.join(outPath, 'green-tunnel/windows-installer'),
        exe: 'green-tunnel.exe',
        setupExe: 'green-tunnel-installer.exe',
        setupIcon: path.join(rootPath, 'icons', 'win', 'icon.ico')
    })
}
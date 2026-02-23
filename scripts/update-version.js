const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const rootPackageJsonPath = path.resolve(__dirname, '../package.json');
const workspaceFilePath = path.resolve(__dirname, '../pnpm-workspace.yaml');

function parseVersion(input) {
    const match = input.match(/^(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z.-]+))?$/);
    if (!match) {
        return null;
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const build = match[4] || null;

    return {
        major,
        minor,
        patch,
        build,
    };
}

function formatVersion(parts) {
    let version = `${parts.major}.${parts.minor}.${parts.patch}`;

    if (parts.build) {
        version += `+${parts.build}`;
    }

    return version;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function readWorkspacePatterns() {
    if (!fs.existsSync(workspaceFilePath)) {
        throw new Error('Cannot find pnpm-workspace.yaml.');
    }

    const content = fs.readFileSync(workspaceFilePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const patterns = [];
    let inPackagesBlock = false;

    for (const line of lines) {
        if (!inPackagesBlock && /^packages:\s*$/.test(line.trim())) {
            inPackagesBlock = true;
            continue;
        }

        if (inPackagesBlock) {
            if (/^\S/.test(line) && !/^\s*-\s*/.test(line)) {
                break;
            }

            const match = line.match(/^\s*-\s*(.+)\s*$/);
            if (match) {
                const pattern = match[1].replace(/^['"]|['"]$/g, '').trim();
                if (pattern) {
                    patterns.push(pattern);
                }
            }
        }
    }

    return patterns;
}

function resolvePatternDirectories(pattern) {
    const segments = pattern.split('/').filter(Boolean);
    let candidates = [repoRoot];

    for (const segment of segments) {
        const nextCandidates = [];

        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) {
                continue;
            }

            if (segment === '*') {
                const children = fs
                    .readdirSync(candidate, { withFileTypes: true })
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => path.join(candidate, entry.name));
                nextCandidates.push(...children);
            } else {
                const direct = path.join(candidate, segment);
                if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
                    nextCandidates.push(direct);
                }
            }
        }

        candidates = nextCandidates;
    }

    return candidates;
}

function discoverWorkspacePackageJsonPaths() {
    const patterns = readWorkspacePatterns();
    const packageJsonPaths = new Set();

    for (const pattern of patterns) {
        const directories = resolvePatternDirectories(pattern);
        for (const directory of directories) {
            const packageJsonPath = path.join(directory, 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                packageJsonPaths.add(path.resolve(packageJsonPath));
            }
        }
    }

    return Array.from(packageJsonPaths).sort();
}

function getNextBuildValue(currentBuild) {
    if (!currentBuild) {
        return '1';
    }

    if (/^\d+$/.test(currentBuild)) {
        return String(Number(currentBuild) + 1);
    }

    const parts = currentBuild.split('.');
    const lastPart = parts[parts.length - 1];
    if (!/^\d+$/.test(lastPart)) {
        return currentBuild;
    }

    parts[parts.length - 1] = String(Number(lastPart) + 1);
    return parts.join('.');
}

function bumpVersion(currentParts, mode) {
    if (mode === 'major') {
        return {
            major: currentParts.major + 1,
            minor: 0,
            patch: 0,
            build: getNextBuildValue(currentParts.build),
        };
    }

    if (mode === 'minor') {
        return {
            major: currentParts.major,
            minor: currentParts.minor + 1,
            patch: 0,
            build: getNextBuildValue(currentParts.build),
        };
    }

    return {
        major: currentParts.major,
        minor: currentParts.minor,
        patch: currentParts.patch + 1,
        build: getNextBuildValue(currentParts.build),
    };
}

function parseManualVersion(raw) {
    const manual = (raw || '').trim();
    if (!manual) {
        return null;
    }

    return parseVersion(manual) ? manual : null;
}

async function promptUser(currentVersion) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    function question(text) {
        return new Promise((resolve) => {
            rl.question(text, (answer) => resolve(answer.trim()));
        });
    }

    console.log(`Current version: ${currentVersion}`);
    console.log('Select update type:');
    console.log('1) Patch update (e.g., 0.1.0+1 -> 0.1.1+2) [default]');
    console.log('2) Minor update (e.g., 0.1.0+1 -> 0.2.0+2)');
    console.log('3) Major update (e.g., 0.1.0+1 -> 1.0.0+2)');
    console.log('4) Manual input full version');

    const choice = await question('Enter choice (1/2/3/4, default 1): ');
    if (choice === '4') {
        const manual = await question('Enter full version: ');
        rl.close();
        return { mode: 'manual', manual };
    }

    rl.close();

    if (!choice || choice === '1') {
        return { mode: 'patch' };
    }
    if (choice === '2') {
        return { mode: 'minor' };
    }
    if (choice === '3') {
        return { mode: 'major' };
    }

    return { mode: 'invalid' };
}

function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

function updateVersionsInPackages(nextVersion) {
    const updatedFiles = [];

    const rootPackageJson = readJson(rootPackageJsonPath);
    rootPackageJson.version = nextVersion;
    writeJson(rootPackageJsonPath, rootPackageJson);
    updatedFiles.push(rootPackageJsonPath);

    const workspacePackageJsonPaths = discoverWorkspacePackageJsonPaths();
    for (const workspacePackageJsonPath of workspacePackageJsonPaths) {
        const workspacePackageJson = readJson(workspacePackageJsonPath);
        workspacePackageJson.version = nextVersion;
        writeJson(workspacePackageJsonPath, workspacePackageJson);
        updatedFiles.push(workspacePackageJsonPath);
    }

    return updatedFiles;
}

function commitUpdatedFiles(nextVersion, updatedFiles) {
    const relativeFiles = updatedFiles.map((filePath) => toPosixPath(path.relative(repoRoot, filePath)));
    const fileArgs = relativeFiles.map((filePath) => `"${filePath}"`).join(' ');

    execSync(`git add -- ${fileArgs}`, { stdio: 'inherit' });
    execSync(`git commit -m "chore: release ${nextVersion}"`, { stdio: 'inherit' });
}

async function main() {
    const rootPackageJson = readJson(rootPackageJsonPath);
    const currentVersion = rootPackageJson.version;
    const currentParts = parseVersion(currentVersion);

    if (!currentParts) {
        console.error('Invalid current version format. Expected: major.minor.patch or major.minor.patch+build');
        process.exit(1);
    }

    const response = await promptUser(currentVersion);

    if (response.mode === 'invalid') {
        console.error('Invalid choice.');
        process.exit(1);
    }

    let nextVersion = '';

    if (response.mode === 'manual') {
        const manualVersion = parseManualVersion(response.manual);
        if (!manualVersion) {
            console.error('Manual version format is invalid.');
            process.exit(1);
        }

        nextVersion = manualVersion;
    } else {
        nextVersion = formatVersion(bumpVersion(currentParts, response.mode));
    }

    const updatedFiles = updateVersionsInPackages(nextVersion);

    console.log(`Updated version to ${nextVersion}`);
    updatedFiles
        .map((filePath) => toPosixPath(path.relative(repoRoot, filePath)))
        .forEach((filePath) => console.log(`- ${filePath}`));

    try {
        commitUpdatedFiles(nextVersion, updatedFiles);
    } catch (error) {
        console.error('Git add/commit failed. Please commit manually if needed.');
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

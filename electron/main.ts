/**
 * FC26 AI Manager — Electron Main Process (Phase 1.1 Hardened Desktop Lifecycle)
 *
 * Security & Lifecycle Guarantees:
 * - Uses app.isPackaged to distinguish packaged production vs local development
 * - Starts and monitors the local Express backend on 127.0.0.1 only (never 0.0.0.0)
 * - Generates a fresh 256-bit per-session Bearer API token shared exclusively with renderer via preload IPC
 * - Stores SQLite database inside persistent Electron app.getPath('userData')
 * - Waits for GET /api/health readiness before loading the React UI
 * - Enforces contextIsolation: true, nodeIntegration: false, sandbox: true, strict CSP
 * - Reports localFfmpegRecording: false honestly until Phase 2 recording is implemented & verified
 */
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, session } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { CaptureSessionEngine } from './captureEngine';

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort = 0;
let backendBaseUrl = '';
let isQuitting = false;
let captureEngine: CaptureSessionEngine | null = null;

// Per-session 256-bit token held strictly in memory for renderer <-> local Express auth
const sessionApiToken = crypto.randomBytes(32).toString('hex');

function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Failed to allocate loopback port.'));
        return;
      }
      const allocatedPort = address.port;
      probe.close(() => resolve(allocatedPort));
    });
  });
}

function resolvePackagedPaths(): {
  serverScriptPath: string;
  staticDistDir: string;
  userDataDbDir: string;
  recordingsRootDir: string;
  referenceDataDir: string;
} {
  const appPath = app.getAppPath();
  const unpackedAppPath = app.isPackaged
    ? appPath.replace(/app\.asar$/i, 'app.asar.unpacked')
    : appPath;

  const candidateServerPaths = [
    path.join(unpackedAppPath, 'dist-server', 'server.mjs'),
    path.join(appPath, 'dist-server', 'server.mjs'),
  ];
  const serverScriptPath =
    candidateServerPaths.find((p) => fs.existsSync(p)) ?? candidateServerPaths[0];

  const candidateRefDataDirs = [
    path.join(unpackedAppPath, 'data', 'fc26'),
    path.join(appPath, 'data', 'fc26'),
  ];
  const referenceDataDir =
    candidateRefDataDirs.find((p) => fs.existsSync(p)) ?? candidateRefDataDirs[0];

  const staticDistDir = path.join(appPath, 'dist');
  const userDataRoot = app.getPath('userData');
  const userDataDbDir = path.join(userDataRoot, 'database');
  const recordingsRootDir = path.join(userDataRoot, 'recordings');

  fs.mkdirSync(userDataDbDir, { recursive: true });
  fs.mkdirSync(recordingsRootDir, { recursive: true });

  return { serverScriptPath, staticDistDir, userDataDbDir, recordingsRootDir, referenceDataDir };
}

function checkHealthOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/health',
        timeout: 1500,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }
          try {
            const parsed = JSON.parse(body) as { ok?: boolean };
            resolve(parsed.ok === true);
          } catch {
            resolve(false);
          }
        });
      }
    );

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForBackendReady(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backendProcess && backendProcess.exitCode !== null) {
      throw new Error(`Local backend exited prematurely with code ${backendProcess.exitCode}.`);
    }
    const healthy = await checkHealthOnce(port);
    if (healthy) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Timed out waiting for local Express backend health check.');
}

async function startLocalBackend(): Promise<void> {
  const { serverScriptPath, staticDistDir, userDataDbDir, recordingsRootDir, referenceDataDir } =
    resolvePackagedPaths();

  captureEngine = new CaptureSessionEngine(recordingsRootDir);

  if (!fs.existsSync(serverScriptPath)) {
    throw new Error(
      `Packaged backend bundle missing at ${serverScriptPath}. Run "npm run build:desktop" before launching Electron.`
    );
  }
  if (!fs.existsSync(path.join(staticDistDir, 'index.html'))) {
    throw new Error(
      `Built React frontend missing at ${staticDistDir}. Run "npm run build:desktop" before launching Electron.`
    );
  }

  backendPort = await findFreeLoopbackPort();
  backendBaseUrl = `http://127.0.0.1:${backendPort}`;

  const child = spawn(process.execPath, [serverScriptPath], {
    cwd: app.isPackaged ? path.dirname(serverScriptPath) : app.getAppPath(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      FC26_DESKTOP_MODE: '1',
      FC26_HOST: '127.0.0.1',
      FC26_PORT: String(backendPort),
      FC26_USER_DATA_DIR: userDataDbDir,
      FC26_STATIC_DIR: staticDistDir,
      FC26_REFERENCE_DATA_DIR: referenceDataDir,
      FC26_API_TOKEN: sessionApiToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProcess = child;

  child.stdout?.on('data', (chunk: Buffer) => {
    console.log(`[backend] ${chunk.toString().trim()}`);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[backend:err] ${chunk.toString().trim()}`);
  });

  child.on('exit', (code, signal) => {
    backendProcess = null;
    if (!isQuitting) {
      console.error(`Local backend stopped unexpectedly (code=${code}, signal=${signal}).`);
      dialog.showErrorBox(
        'FC26 AI Manager — Backend Stopped',
        `The local database backend stopped unexpectedly (exit code ${code ?? 'unknown'}). Please restart FC26 AI Manager.`
      );
      app.quit();
    }
  });

  await waitForBackendReady(backendPort);
}

function stopLocalBackend(): void {
  if (!backendProcess || backendProcess.killed) return;
  const proc = backendProcess;
  backendProcess = null;
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, 3000).unref();
  } catch {
    // ignore termination errors on exit
  }
}

function createMainWindow(): void {
  const preloadPath = path.join(__dirname, 'preload.cjs');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 740,
    backgroundColor: '#0B0D10',
    title: 'FC26 AI Manager — Football Tactical Intelligence System',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Strict CSP scoped strictly to this session's 127.0.0.1 backend origin
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ${backendBaseUrl};`,
        ],
      },
    });
  });

  void mainWindow.loadURL(backendBaseUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:get-backend-connection', async () => {
    return {
      baseUrl: backendBaseUrl,
      apiToken: sessionApiToken,
    };
  });

  ipcMain.handle('desktop:get-capabilities', async () => {
    return {
      environment: 'electron-native',
      nativeWindowCapture: true,
      localFfmpegRecording: false, // Phase 2: FFmpeg segmented capture not yet implemented
      nativeDiskInspection: true,
      safeStorageAvailable: safeStorage.isEncryptionAvailable(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      notice:
        'Native Windows Electron runtime active. Local SQLite storage (userData) and window/display enumeration are active; FFmpeg segmented video recording is planned for Phase 2.',
    };
  });

  ipcMain.handle('capture:list-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: false,
    });

    return sources.map((src) => ({
      id: src.id,
      name: src.name,
      type: src.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnailDataUrl: src.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle('capture:disk-space', async (_event, targetSubdir: string) => {
    const baseDir = path.resolve(app.getPath('userData'), 'recordings');
    const safeName = targetSubdir ? path.basename(targetSubdir).replace(/[^a-zA-Z0-9._-]/g, '') : '';
    const resolved = safeName ? path.resolve(baseDir, safeName) : baseDir;
    if (!resolved.startsWith(baseDir)) {
      throw new Error('Invalid storage inspection path.');
    }
    fs.mkdirSync(resolved, { recursive: true });
    const stats = fs.statfsSync(resolved);
    return {
      path: resolved,
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
      isEstimate: false,
    };
  });

  ipcMain.handle('capture:get-recoverable-sessions', async () => {
    return captureEngine ? captureEngine.scanRecoverableManifests() : [];
  });

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });
}

app.whenReady().then(async () => {
  try {
    registerIpcHandlers();
    await startLocalBackend();
    createMainWindow();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Fatal Electron startup error:', message);
    dialog.showErrorBox('FC26 AI Manager — Startup Failed', message);
    isQuitting = true;
    stopLocalBackend();
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && backendBaseUrl) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  stopLocalBackend();
});

app.on('will-quit', () => {
  isQuitting = true;
  stopLocalBackend();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

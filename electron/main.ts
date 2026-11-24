/**
 * FC26 AI Manager — Electron Main Process (Windows Desktop Packaging Entrypoint)
 *
 * Security boundaries enforced:
 * - contextIsolation: true
 * - nodeIntegration: false
 * - sandbox: true
 * - Strict Content-Security-Policy
 * - All Gemini credentials kept in Electron safeStorage (never sent to renderer)
 * - No OS shell execution from AI outputs, no FC26 input interception
 */
import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { CaptureSessionEngine } from './captureEngine';

const isDev = process.env.NODE_ENV !== 'production';
let mainWindow: BrowserWindow | null = null;
const captureEngine = new CaptureSessionEngine(path.join(app.getPath('documents'), 'FC26_AI_Manager'));

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 740,
    backgroundColor: '#0B0D10',
    title: 'FC26 AI Manager — Football Tactical Intelligence System',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Apply strict CSP header for production renderer
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:3000 http://localhost:3000;",
        ],
      },
    });
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:get-capabilities', async () => {
    return {
      environment: 'electron-native',
      nativeWindowCapture: true,
      localFfmpegRecording: true,
      nativeDiskInspection: true,
      safeStorageAvailable: safeStorage.isEncryptionAvailable(),
      platform: process.platform,
      notice: 'Native Windows Electron runtime active. Local desktop capture and SQLite storage enabled.',
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

  ipcMain.handle('capture:disk-space', async (_event, targetDir: string) => {
    const baseDir = path.resolve(app.getPath('documents'), 'FC26_AI_Manager');
    const resolved = targetDir ? path.resolve(baseDir, path.basename(targetDir)) : baseDir;
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
    return captureEngine.scanRecoverableManifests();
  });

  ipcMain.handle('capture:prepare-session', async (_event, payload: {
    matchId: string;
    half: 'first_half' | 'second_half';
    sourceId: string;
    sourceName: string;
    resolution: string;
    fps: number;
    segmentDurationMinutes: number;
  }) => {
    return captureEngine.createSessionManifest(payload);
  });

  ipcMain.handle('capture:finalize-session', async (_event, sessionId: string) => {
    return captureEngine.finalizeSessionManifest(sessionId);
  });

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

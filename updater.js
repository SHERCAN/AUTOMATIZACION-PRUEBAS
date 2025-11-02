import axios from "axios";
import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Updater {
  constructor(options = {}) {
    this.owner = options.owner || "SHERCAN";
    this.repo = options.repo || "AUTOMATIZACION-PRUEBAS";
    this.currentVersion = options.currentVersion || "1.0.0";
    this.apiUrl = `https://api.github.com/repos/${this.owner}/${this.repo}/releases/latest`;
  }

  async checkForUpdates() {
    try {
      console.log("🔍 Verificando actualizaciones...");

      // Si detectamos que ya se está actualizando, salir
      const currentExePath = process.execPath;
      const updatingFlag = currentExePath + ".updating";

      if (await fs.pathExists(updatingFlag)) {
        console.log("⏳ Actualización en proceso detectada, limpiando...");
        await fs.remove(updatingFlag);
      }

      const response = await axios.get(this.apiUrl, {
        headers: {
          Accept: "application/vnd.github.v3+json",
        },
        timeout: 10000,
      });

      const latestVersion = response.data.tag_name.replace("v", "");
      const latestRelease = response.data;

      console.log(`Versión actual: ${this.currentVersion}`);
      console.log(`Última versión: ${latestVersion}`);

      if (this.isNewerVersion(latestVersion, this.currentVersion)) {
        console.log("✨ Nueva versión disponible!");
        return {
          available: true,
          version: latestVersion,
          assets: latestRelease.assets,
          releaseUrl: latestRelease.html_url,
        };
      } else {
        console.log("✅ Ya estás en la última versión");
        return { available: false };
      }
    } catch (error) {
      console.error("❌ Error al verificar actualizaciones:", error.message);
      return { available: false, error: error.message };
    }
  }

  isNewerVersion(latest, current) {
    const latestParts = latest.split(".").map(Number);
    const currentParts = current.split(".").map(Number);

    for (
      let i = 0;
      i < Math.max(latestParts.length, currentParts.length);
      i++
    ) {
      const l = latestParts[i] || 0;
      const c = currentParts[i] || 0;
      if (l > c) return true;
      if (l < c) return false;
    }
    return false;
  }

  async downloadUpdate(assets) {
    try {
      const platform = process.platform;
      const isWindows = platform === "win32";
      const executableName = isWindows ? "miapp-win.exe" : "miapp-linux";

      const asset = assets.find((a) => a.name === executableName);

      if (!asset) {
        console.error("❌ No se encontró el archivo para tu plataforma");
        return null;
      }

      console.log(`📥 Descargando actualización: ${asset.name}...`);

      const response = await axios.get(asset.browser_download_url, {
        responseType: "arraybuffer",
        onDownloadProgress: (progressEvent) => {
          const percentCompleted = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          process.stdout.write(`\r📊 Progreso: ${percentCompleted}%`);
        },
        timeout: 60000,
      });

      console.log("\n✅ Descarga completada");

      const currentExePath = process.execPath;
      const updateDir = path.dirname(currentExePath);
      const tempPath = path.join(updateDir, `${executableName}.new`);

      await fs.writeFile(tempPath, response.data);

      if (!isWindows) {
        await fs.chmod(tempPath, 0o755);
      }

      return { currentExePath, tempPath, isWindows, updateDir };
    } catch (error) {
      console.error("❌ Error al descargar actualización:", error.message);
      return null;
    }
  }

  async applyUpdate(updatePaths) {
    try {
      const { currentExePath, tempPath, isWindows, updateDir } = updatePaths;
      const backupPath = currentExePath + ".backup";
      const updatingFlag = currentExePath + ".updating";

      console.log("🔄 Aplicando actualización...");

      // Marcar que estamos actualizando
      await fs.writeFile(updatingFlag, new Date().toISOString());

      // Crear backup del ejecutable actual
      if (await fs.pathExists(currentExePath)) {
        await fs.copy(currentExePath, backupPath, { overwrite: true });
      }

      if (isWindows) {
        // Script mejorado para Windows
        const batchScript = `@echo off
chcp 65001 >nul
echo Aplicando actualización...
timeout /t 3 /nobreak >nul

:RETRY
del /F /Q "${currentExePath}" 2>nul
if exist "${currentExePath}" (
  timeout /t 1 /nobreak >nul
  goto RETRY
)

move /Y "${tempPath}" "${currentExePath}"
if errorlevel 1 (
  echo Error al mover el archivo
  copy /Y "${backupPath}" "${currentExePath}"
  del /F /Q "${updatingFlag}" 2>nul
  pause
  exit /b 1
)

del /F /Q "${backupPath}" 2>nul
del /F /Q "${updatingFlag}" 2>nul

echo Actualización completada. Iniciando aplicación...
start "" "${currentExePath}"

timeout /t 1 /nobreak >nul
del "%~f0"
`;

        const batchPath = path.join(updateDir, "update.bat");
        await fs.writeFile(batchPath, batchScript);

        console.log("✅ Actualización preparada. Reiniciando en 3 segundos...");
        console.log("⚠️  No cierres esta ventana manualmente");

        // Esperar un momento antes de ejecutar
        await new Promise((resolve) => setTimeout(resolve, 1000));

        spawn("cmd.exe", ["/c", batchPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        }).unref();

        // Dar tiempo para que el batch inicie
        await new Promise((resolve) => setTimeout(resolve, 500));
        process.exit(0);
      } else {
        // Para Linux
        const shellScript = `#!/bin/bash
sleep 3
rm -f "${currentExePath}"
mv "${tempPath}" "${currentExePath}"
chmod +x "${currentExePath}"
rm -f "${backupPath}"
rm -f "${updatingFlag}"
"${currentExePath}" &
`;

        const shellPath = path.join(updateDir, "update.sh");
        await fs.writeFile(shellPath, shellScript);
        await fs.chmod(shellPath, 0o755);

        console.log("✅ Actualización preparada. Reiniciando...");

        spawn(shellPath, [], {
          detached: true,
          stdio: "ignore",
        }).unref();

        await new Promise((resolve) => setTimeout(resolve, 500));
        process.exit(0);
      }
    } catch (error) {
      console.error("❌ Error al aplicar actualización:", error.message);

      // Limpiar en caso de error
      const updatingFlag = updatePaths.currentExePath + ".updating";
      if (await fs.pathExists(updatingFlag)) {
        await fs.remove(updatingFlag);
      }

      return false;
    }
  }

  async update() {
    const updateInfo = await this.checkForUpdates();

    if (!updateInfo.available) {
      return false;
    }

    console.log("\n🚀 Iniciando proceso de actualización...");
    const updatePaths = await this.downloadUpdate(updateInfo.assets);

    if (!updatePaths) {
      return false;
    }

    await this.applyUpdate(updatePaths);
    return true;
  }
}

export default Updater;

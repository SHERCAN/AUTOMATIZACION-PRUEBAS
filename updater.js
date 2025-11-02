const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

class Updater {
  constructor(options = {}) {
    this.owner = options.owner || 'SHERCAN';
    this.repo = options.repo || 'AUTOMATIZACION-PRUEBAS';
    this.currentVersion = options.currentVersion || require('./package.json').version;
    this.apiUrl = `https://api.github.com/repos/${this.owner}/${this.repo}/releases/latest`;
  }

  async checkForUpdates() {
    try {
      console.log('🔍 Verificando actualizaciones...');
      const response = await axios.get(this.apiUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      const latestVersion = response.data.tag_name.replace('v', '');
      const latestRelease = response.data;

      console.log(`Versión actual: ${this.currentVersion}`);
      console.log(`Última versión: ${latestVersion}`);

      if (this.isNewerVersion(latestVersion, this.currentVersion)) {
        console.log('✨ Nueva versión disponible!');
        return {
          available: true,
          version: latestVersion,
          assets: latestRelease.assets,
          releaseUrl: latestRelease.html_url
        };
      } else {
        console.log('✅ Ya estás en la última versión');
        return { available: false };
      }
    } catch (error) {
      console.error('❌ Error al verificar actualizaciones:', error.message);
      return { available: false, error: error.message };
    }
  }

  isNewerVersion(latest, current) {
    const latestParts = latest.split('.').map(Number);
    const currentParts = current.split('.').map(Number);

    for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
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
      const isWindows = platform === 'win32';
      const executableName = isWindows ? 'miapp-win.exe' : 'miapp-linux';
      
      const asset = assets.find(a => a.name === executableName);
      
      if (!asset) {
        console.error('❌ No se encontró el archivo para tu plataforma');
        return null;
      }

      console.log(`📥 Descargando actualización: ${asset.name}...`);
      
      const response = await axios.get(asset.browser_download_url, {
        responseType: 'arraybuffer',
        onDownloadProgress: (progressEvent) => {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          process.stdout.write(`\r📊 Progreso: ${percentCompleted}%`);
        }
      });

      console.log('\n✅ Descarga completada');
      
      const currentExePath = process.execPath;
      const tempPath = currentExePath + '.new';
      
      await fs.writeFile(tempPath, response.data);
      
      if (!isWindows) {
        await fs.chmod(tempPath, 0o755);
      }
      
      return { currentExePath, tempPath, isWindows };
    } catch (error) {
      console.error('❌ Error al descargar actualización:', error.message);
      return null;
    }
  }

  async applyUpdate(updatePaths) {
    try {
      const { currentExePath, tempPath, isWindows } = updatePaths;
      const backupPath = currentExePath + '.backup';

      console.log('🔄 Aplicando actualización...');

      // Crear backup del ejecutable actual
      await fs.copy(currentExePath, backupPath);

      if (isWindows) {
        // En Windows, crear un script batch para reemplazar y reiniciar
        const batchScript = `
@echo off
timeout /t 2 /nobreak > nul
del /F /Q "${currentExePath}"
move /Y "${tempPath}" "${currentExePath}"
start "" "${currentExePath}"
del "%~f0"
        `.trim();

        const batchPath = path.join(path.dirname(currentExePath), 'update.bat');
        await fs.writeFile(batchPath, batchScript);
        
        console.log('✅ Actualización preparada. Reiniciando...');
        
        spawn('cmd.exe', ['/c', batchPath], {
          detached: true,
          stdio: 'ignore'
        }).unref();
        
        process.exit(0);
      } else {
        // En Linux/Unix, reemplazar directamente
        await fs.move(tempPath, currentExePath, { overwrite: true });
        await fs.chmod(currentExePath, 0o755);
        
        console.log('✅ Actualización aplicada. Reiniciando...');
        
        spawn(currentExePath, process.argv.slice(2), {
          detached: true,
          stdio: 'ignore'
        }).unref();
        
        process.exit(0);
      }
    } catch (error) {
      console.error('❌ Error al aplicar actualización:', error.message);
      return false;
    }
  }

  async update() {
    const updateInfo = await this.checkForUpdates();
    
    if (!updateInfo.available) {
      return false;
    }

    console.log('\n🚀 Iniciando proceso de actualización...');
    const updatePaths = await this.downloadUpdate(updateInfo.assets);
    
    if (!updatePaths) {
      return false;
    }

    await this.applyUpdate(updatePaths);
    return true;
  }
}

module.exports = Updater;
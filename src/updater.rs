use anyhow::{Context, Result};
use chrono::Utc;
use reqwest::Client;
use serde::Deserialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::{env, fs, process};

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

pub struct Updater {
    owner: String,
    repo: String,
    current: String,
    client: Client,
}

impl Updater {
    pub fn new() -> Self {
        Self {
            owner: "SHERCAN".into(),
            repo: "AUTOMATIZACION-PRUEBAS".into(),
            current: env!("CARGO_PKG_VERSION").into(),
            client: Client::new(),
        }
    }

    /*  ----  check for updates  ----  */
    async fn check(&self) -> Result<Option<Release>> {
        let flag = self.updating_flag();
        if flag.exists() {
            println!("⏳ Actualización en proceso detectada, limpiando...");
            let _ = fs::remove_file(&flag);
        }

        let url = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            self.owner, self.repo
        );
        let rel: Release = self
            .client
            .get(&url)
            .header("User-Agent", "request")
            .send()
            .await?
            .json()
            .await?;

        let latest = rel.tag_name.trim_start_matches('v');
        println!("Versión actual : {}", self.current);
        println!("Última versión : {}", latest);

        if self.is_newer(latest, &self.current) {
            println!("✨ Nueva versión disponible!");
            Ok(Some(rel))
        } else {
            println!("✅ Ya estás en la última versión");
            Ok(None)
        }
    }

    /*  ----  download asset  ----  */
    /*  ----  descarga  ----  */
    async fn download(&self, rel: &Release) -> Result<PathBuf> {
        let asset_name = if cfg!(windows) {
            "miapp-win.exe"
        } else {
            "miapp-linux"
        };

        let asset = rel
            .assets
            .iter()
            .find(|a| a.name == asset_name)
            .context("No se encontró el archivo para tu plataforma")?;

        println!("📥 Descargando {} ...", asset.name);

        let resp = self.client.get(&asset.browser_download_url).send().await?;
        let total = resp.content_length().unwrap_or(0);

        let tmp = self.current_exe().with_extension("new");
        let mut file = fs::File::create(&tmp)?;
        let bytes = resp.bytes().await?; // <- en vez de bytes_stream()
        file.write_all(&bytes)?;

        let downloaded = bytes.len() as u64;
        let pct = (downloaded * 100) / total.max(1);
        println!("\r📊 Progreso: {} %", pct);
        println!("✅ Descarga completada");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))?;
        }

        Ok(tmp)
    }

    /*  ----  apply update  ----  */
    pub async fn apply(&self, new: &Path) -> Result<()> {
        let current = self.current_exe();
        let old = current.with_extension("old");

        println!("🔄 Aplicando actualización...");

        // 1. Renombramos el ejecutable actual a .old
        // En Windows esto es legal aunque el programa esté corriendo.
        if old.exists() {
            let _ = fs::remove_file(&old);
        }
        fs::rename(&current, &old).context("No se pudo renombrar el archivo actual")?;

        // 2. Movemos el nuevo ejecutable al nombre original
        fs::rename(new, &current).context("No se pudo mover el nuevo archivo")?;

        println!("✅ Actualización preparada. Reiniciando...");

        // 3. Iniciamos la nueva versión
        process::Command::new(&current)
            .spawn()
            .context("No se pudo reiniciar la aplicación")?;

        // 4. Salimos
        process::exit(0);
    }

    /*  -------  Limpieza de archivos viejos al arrancar  ------- */
    pub fn cleanup() {
        if let Ok(exe) = env::current_exe() {
            let old = exe.with_extension("old");
            if old.exists() {
                let _ = fs::remove_file(old);
            }
            let updating = exe.with_extension("updating");
            if updating.exists() {
                let _ = fs::remove_file(updating);
            }
        }
    }

    /*  ----  helpers  ----  */
    fn is_newer(&self, a: &str, b: &str) -> bool {
        let a: Vec<u32> = a.split('.').map(|s| s.parse().unwrap_or(0)).collect();
        let b: Vec<u32> = b.split('.').map(|s| s.parse().unwrap_or(0)).collect();
        a > b
    }

    fn current_exe(&self) -> PathBuf {
        env::current_exe().expect("cannot get current exe path")
    }

    fn updating_flag(&self) -> PathBuf {
        self.current_exe().with_extension("updating")
    }
}

/*  -------  función pública que usa main.rs  ------- */
pub async fn check_and_update() -> Result<bool> {
    let up = Updater::new();
    match up.check().await? {
        Some(rel) => {
            let new_exe = up.download(&rel).await?;
            up.apply(&new_exe).await?;
            Ok(true) // sí hubo actualización
        }
        None => Ok(false), // ya estaba actualizado
    }
}

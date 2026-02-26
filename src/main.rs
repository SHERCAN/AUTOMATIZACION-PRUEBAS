mod config;
mod updater;

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose};
use config::{ApiConfig, Config};
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::json;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use tokio::fs;
use tokio::task;
use tokio::sync::Barrier;

#[tokio::main]
async fn main() -> Result<()> {
    #[cfg(windows)]
    {
        use winapi::um::wincon::SetConsoleOutputCP;
        unsafe {
            SetConsoleOutputCP(65001); // UTF-8
        }
    }

    // Limpiar archivos de actualización anteriores (.old)
    updater::Updater::cleanup();

    println!("═══════════════════════════════════════");
    println!("  Verificador de Actualizaciones");
    println!("═══════════════════════════════════════\n");

    if let Err(e) = updater::check_and_update().await {
        eprintln!("⚠️ Error al verificar actualizaciones: {}", e);
    }

    println!("\n═══════════════════════════════════════\n");

    if let Err(e) = ejecutar().await {
        eprintln!("❌ Error general: {}", e);
    }

    println!("\n✋ Presiona ENTER para cerrar...");
    let mut input = String::new();
    std::io::stdin().read_line(&mut input)?;

    Ok(())
}

async fn ejecutar() -> Result<()> {
    let config = cargar_config().await?;
    let token = obtener_token(&config).await?;

    let mut grupos: std::collections::HashMap<u8, Vec<(&String, &ApiConfig)>> =
        std::collections::HashMap::new();

    for (nombre, api) in &config.apis {
        let nivel = api.concurrencia.unwrap_or(1);
        grupos.entry(nivel).or_default().push((nombre, api));
    }

    let mut niveles: Vec<_> = grupos.into_iter().collect();
    niveles.sort_by_key(|(nivel, _)| *nivel);

    for (nivel, apis) in niveles {
        println!(
            "\n📦 Ejecutando GRUPO {} ({} APIs en paralelo)",
            nivel,
            apis.len()
        );
        let mut tareas = vec![];
        for (_nombre, api) in apis {
            let n_repeticiones = api.repeticiones.unwrap_or(1);
            
            // Preparar los datos una sola vez para todas las repeticiones del mismo API
            println!("📝 Preparando datos para API {}...", _nombre);
            let datos_preparados = preparar_datos(api, &token, nivel, &config).await?;
            
            let client = reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .build()?;
            
            let arc_datos = Arc::new(datos_preparados);
            let arc_client = Arc::new(client);
            let barrera = Arc::new(Barrier::new(n_repeticiones as usize));
            
            println!("🚀 Disparando {} repeticiones simultáneas...", n_repeticiones);
            
            for i in 1..=n_repeticiones {
                let datos = Arc::clone(&arc_datos);
                let client = Arc::clone(&arc_client);
                let b = Arc::clone(&barrera);
                
                tareas.push(task::spawn(async move {
                    // Esperar a que TODOS estén listos en la barrera
                    b.wait().await;
                    // Enviar inmediatamente
                    enviar_datos(client, datos, i).await
                }));
            }
        }
        for t in tareas {
            let _ = t.await;
        }
        println!("✅ Grupo {} completado\n", nivel);
    }

    println!("✅ Todos los envíos completados.");
    Ok(())
}

async fn cargar_config() -> Result<Config> {
    let content = fs::read_to_string("config.yml").await?;
    let config: Config = serde_yaml::from_str(&content)?;
    Ok(config)
}

async fn obtener_token(config: &Config) -> Result<String> {
    println!("🔑 Generando nuevo token...");
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true) // Aceptar certificados inválidos (solo para pruebas)
        .build()?;
    let url = format!("{}{}", config.base_url, config.auth_endpoint);
    let res = client.post(&url).json(&config.auth_data).send().await?;
    let json: serde_json::Value = res.json().await?;
    let token = json["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("No se encontró el token"))?;
    println!("✅ Token generado correctamente");
    Ok(token.to_string())
}

struct DatosEnvio {
    url: String,
    body: String,
    headers: reqwest::header::HeaderMap,
    carpeta: String,
    nombre_base: String,
    indice_envio: u8,
}

async fn preparar_datos(api: &ApiConfig, token: &str, nivel_concurrencia: u8, config: &Config) -> Result<DatosEnvio> {
    let carpeta = api.carpeta_archivos.clone();
    fs::create_dir_all(&carpeta).await?;

    let mut entries = fs::read_dir(&carpeta).await?;
    let mut json_file = None;
    let mut xml_file = None;

    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.to_lowercase().ends_with(".json") && json_file.is_none() {
            json_file = Some(name);
        } else if name.to_lowercase().ends_with(".xml") && xml_file.is_none() {
            xml_file = Some(name);
        }
    }

    if json_file.is_none() && xml_file.is_none() {
        return Err(anyhow::anyhow!("No hay archivos en {}", carpeta));
    }

    let mut payload = json!({"rips": null, "xmlFevFile": null});

    if let Some(json_name) = &json_file {
        let path = Path::new(&carpeta).join(json_name);
        let bytes = fs::read(&path).await?;
        let content_cleaned = String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').trim().to_string();
        payload["rips"] = serde_json::from_str(&content_cleaned)?;
    }

    if let Some(xml_name) = &xml_file {
        let path = Path::new(&carpeta).join(xml_name);
        let content = fs::read_to_string(&path).await?;
        payload["xmlFevFile"] = json!(general_purpose::STANDARD.encode(content));
    }

    let mut body = serde_json::to_string(&payload)?;
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Authorization", format!("Bearer {}", token).parse()?);
    headers.insert("Content-Type", "application/json".parse()?);

    if api.comprimir.unwrap_or(false) {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(body.as_bytes())?;
        body = String::from_utf8(encoder.finish()?)?;
        headers.insert("Content-Encoding", "gzip".parse()?);
    }

    let nombre_base = json_file.or(xml_file).unwrap();
    let nombre_base = Path::new(&nombre_base).file_stem().unwrap().to_string_lossy().to_string();

    Ok(DatosEnvio {
        url: format!("{}{}", config.base_url, api.endpoint),
        body,
        headers,
        carpeta,
        nombre_base,
        indice_envio: nivel_concurrencia,
    })
}

async fn enviar_datos(client: Arc<reqwest::Client>, datos: Arc<DatosEnvio>, item_rep: u32) -> Result<()> {
    let res = client.post(&datos.url)
        .headers(datos.headers.clone())
        .body(datos.body.clone())
        .send().await?;

    let sufijo = format!("_envio{}_rep{}", datos.indice_envio, item_rep);
    let mut response_path = Path::new(&datos.carpeta).join(format!("{}{}_res.txt", datos.nombre_base, sufijo));
    
    // Para no bloquearnos con chequeos de existencia de archivo en el envío masivo, 
    // confiamos en el nombre único por repetición.
    let response_text = res.text().await?;
    fs::write(&response_path, response_text).await?;
    
    Ok(())
}


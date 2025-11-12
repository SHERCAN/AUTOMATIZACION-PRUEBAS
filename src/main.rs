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
use tokio::fs;
use tokio::task;

#[tokio::main]
async fn main() -> Result<()> {
    #[cfg(windows)]
    {
        use winapi::um::wincon::SetConsoleOutputCP;
        unsafe {
            SetConsoleOutputCP(65001); // UTF-8
        }
    }
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
            // <-- _nombre
            let api = api.clone();
            let token = token.clone();
            // let config = config.clone();   // <-- NO se usa → bórrala o marca _config
            tareas.push(task::spawn(async move {
                procesar_carpeta(&api, &token, nivel).await
            }));
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
    let client = reqwest::Client::new();
    let url = format!("{}{}", config.base_url, config.auth_endpoint);
    let res = client.post(&url).json(&config.auth_data).send().await?;
    let json: serde_json::Value = res.json().await?;
    let token = json["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("No se encontró el token"))?;
    println!("✅ Token generado correctamente");
    Ok(token.to_string())
}

async fn procesar_carpeta(api: &ApiConfig, token: &str, indice_envio: u8) -> Result<()> {
    let carpeta = &api.carpeta_archivos;
    fs::create_dir_all(carpeta).await?;

    let mut entries = fs::read_dir(carpeta).await?;
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

    let mut payload = json!({
        "rips": null,
        "xmlFevFile": null
    });

    if let Some(json_name) = &json_file {
        let path = Path::new(carpeta).join(json_name);
        let content = fs::read_to_string(&path).await?;
        let parsed = serde_json::from_str::<serde_json::Value>(&content);
        payload["rips"] = parsed.unwrap_or_else(|_| json!({ "raw": content }));
        println!("📄 JSON encontrado: {}", json_name);
    } else {
        println!("ℹ️ No se encontró archivo JSON");
    }

    if let Some(xml_name) = &xml_file {
        let path = Path::new(carpeta).join(xml_name);
        let content = fs::read_to_string(&path).await?;
        payload["xmlFevFile"] = json!(general_purpose::STANDARD.encode(content));
        println!("📄 XML encontrado: {}", xml_name);
    } else {
        println!("ℹ️ No se encontró archivo XML");
    }

    if json_file.is_none() && xml_file.is_none() {
        eprintln!(
            "⚠️ No hay archivos JSON ni XML para procesar en {}",
            carpeta
        );
        return Ok(());
    }

    let archivos_texto = [json_file.as_ref(), xml_file.as_ref()]
        .iter() // Iterador sobre Option<&String>
        .flatten() // quitamos el Option (None se ignora)
        .copied() // &&String  →  &String
        .cloned() // &String   →  String
        .collect::<Vec<String>>()
        .join(" + ");
    println!("🚀 Enviando: {}", archivos_texto);

    let mut body = serde_json::to_string(&payload)?;
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Authorization", format!("Bearer {}", token).parse()?);
    headers.insert("Content-Type", "application/json".parse()?);

    if api.comprimir.unwrap_or(false) {
        println!("🗜️ Comprimiendo payload con gzip...");
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(body.as_bytes())?;
        body = String::from_utf8(encoder.finish()?)?;
        headers.insert("Content-Encoding", "gzip".parse()?);
    }

    let client = reqwest::Client::new();
    let url = format!("{}{}", "http://example.com", api.endpoint); // Ajusta con tu base_url real
    let res = client.post(&url).headers(headers).body(body).send().await?;

    let nombre_base = json_file.unwrap_or_else(|| xml_file.unwrap());
    let nombre_base = Path::new(&nombre_base)
        .file_stem()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let sufijo = format!("_envio{}", indice_envio);
    let mut response_path = Path::new(carpeta).join(format!("{}{}_res.txt", nombre_base, sufijo));
    let mut counter = 1;
    while response_path.exists() {
        response_path =
            Path::new(carpeta).join(format!("{}{}_res_{}.txt", nombre_base, sufijo, counter));
        counter += 1;
    }

    let response_text = res.text().await?;
    fs::write(&response_path, response_text).await?;
    println!("✅ Enviado correctamente -> {}", response_path.display());

    Ok(())
}

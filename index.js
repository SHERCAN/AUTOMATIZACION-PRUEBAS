import fs from "fs-extra";
import path from "path";
import axios from "axios";
import yaml from "js-yaml";
import { gzip } from "node-gzip";
import pLimit from "p-limit";
import { json } from "stream/consumers";

const CONFIG_PATH = "./config.yml";

async function loadConfig() {
  const file = await fs.readFile(CONFIG_PATH, "utf8");
  return yaml.load(file);
}

async function obtenerToken(config) {
  const now = Date.now();
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.log("🔑 Generando nuevo token...");
  const url = `${config.base_url}${config.auth_endpoint}`;
  try {
    const res = await axios.post(url, config.auth_data, {
      headers: { "Content-Type": "application/json" },
    });
    const token = res.data.token;

    console.log("✅ Token generado correctamente");
    return token;
  } catch (err) {
    console.error("❌ Error generando token:", err.message);
    throw err;
  }
}

async function procesarCarpeta(apiConfig, token, indiceEnvio = 1) {
  const carpetaSalida = apiConfig.carpeta_archivos;
  await fs.ensureDir(carpetaSalida);

  const headersBase = { Authorization: `Bearer ${token}` };

  async function guardar(pathDestino, obj) {
    await fs.writeFile(pathDestino, JSON.stringify(obj, null, 2), "utf8");
  }

  try {
    // Leer todos los archivos de la carpeta
    const archivos = (await fs.readdir(apiConfig.carpeta_archivos)).filter(
      (f) => f.endsWith(".json") || f.endsWith(".xml")
    );

    let payload = {
      rips: null,
      xmlFevFile: null
    };

    let archivoJson = null;
    let archivoXml = null;

    // Buscar archivos JSON y XML
    for (const archivo of archivos) {
      const ext = path.parse(archivo).ext.toLowerCase();
      
      if (ext === ".json" && !archivoJson) {
        archivoJson = archivo;
      } else if (ext === ".xml" && !archivoXml) {
        archivoXml = archivo;
      }
    }

    // Procesar JSON si existe
    if (archivoJson) {
      const rutaJson = path.join(apiConfig.carpeta_archivos, archivoJson);
      const jsonRaw = await fs.readFile(rutaJson, "utf8");
      try {
        payload.rips = JSON.parse(jsonRaw);
      } catch (e) {
        payload.rips = { raw: jsonRaw };
      }
      console.log(`📄 JSON encontrado: ${archivoJson}`);
    } else {
      console.log(`ℹ️ No se encontró archivo JSON`);
    }

    // Procesar XML si existe
    if (archivoXml) {
      const rutaXml = path.join(apiConfig.carpeta_archivos, archivoXml);
      const xmlData = await fs.readFile(rutaXml, "utf8");
      payload.xmlFevFile = Buffer.from(xmlData, "utf8").toString("base64");
      console.log(`📄 XML encontrado: ${archivoXml}`);
    } else {
      console.log(`ℹ️ No se encontró archivo XML`);
    }

    // Verificar que al menos un archivo existe
    if (!archivoJson && !archivoXml) {
      console.log(`⚠️ No hay archivos JSON ni XML para procesar en ${apiConfig.carpeta_archivos}`);
      return;
    }

    const archivosTexto = [archivoJson, archivoXml].filter(Boolean).join(" + ");
    console.log(`🚀 Enviando: ${archivosTexto}`);
    console.log("url:", apiConfig.url);
    console.log("payload keys:", Object.keys(payload));

    const finalHeaders = { 
      ...headersBase, 
      "Content-Type": "application/json" 
    };
    let bodyToSend = JSON.stringify(payload);
    if (apiConfig.comprimir === true) {
      console.log("🗜️ Comprimiendo payload con gzip...");
      bodyToSend = await gzip(bodyToSend);
      finalHeaders["Content-Encoding"] = "gzip";
    }
    const res = await axios.post(apiConfig.url, bodyToSend, {
      headers: finalHeaders,
    });

    const sufijo = `_envio${indiceEnvio}`;
    const nombreBase = archivoJson ? path.parse(archivoJson).name : path.parse(archivoXml).name;
    
    // Buscar un nombre de archivo único
    let contador = 1;
    let responsePath = path.join(
      carpetaSalida,
      `${nombreBase}${sufijo}_res.txt`
    );
    
    while (await fs.pathExists(responsePath)) {
      responsePath = path.join(
        carpetaSalida,
        `${nombreBase}${sufijo}_res_${contador}.txt`
      );
      contador++;
    }

    await guardar(responsePath, res.data);
    console.log(`✅ Enviado correctamente -> ${responsePath}`);
    
  } catch (err) {
    console.log(err);
    const sufijo = `_envio${indiceEnvio}`;
    
    // Buscar un nombre de archivo único para errores
    let contador = 1;
    let errorPath = path.join(
      carpetaSalida,
      `error${sufijo}_res_error.txt`
    );
    
    while (await fs.pathExists(errorPath)) {
      errorPath = path.join(
        carpetaSalida,
        `error${sufijo}_res_error_${contador}.txt`
      );
      contador++;
    }
    
    let responseBody = null;
    if (err.response) {
      if (typeof err.response.data === "object") {
        responseBody = err.response.data;
      } else {
        responseBody = { rawBody: String(err.response.data) };
      }
    } else {
      responseBody = { error: err.message };
    }
    
    await guardar(errorPath, responseBody);
    console.error(`❌ Error enviando: ${JSON.stringify(responseBody)}`);
    console.log(`⚠️  Detalle guardado en: ${errorPath}`);
  }
}

async function ejecutar() {
  const config = await loadConfig();
  const token = await obtenerToken(config);

  // Agrupar APIs por nivel de concurrencia
  const gruposPorConcurrencia = new Map();
  
  for (const [apiName, apiConfig] of Object.entries(config.apis)) {
    const nivel = Number(apiConfig.concurrencia) || 1;
    if (!gruposPorConcurrencia.has(nivel)) {
      gruposPorConcurrencia.set(nivel, []);
    }
    gruposPorConcurrencia.get(nivel).push({ apiName, apiConfig });
  }

  // Ordenar los grupos por nivel (1, 2, 3, ...)
  const nivelesOrdenados = Array.from(gruposPorConcurrencia.keys()).sort((a, b) => a - b);

  // Ejecutar grupos secuencialmente
  for (const nivel of nivelesOrdenados) {
    const apisEnGrupo = gruposPorConcurrencia.get(nivel);
    console.log(`\n📦 Ejecutando GRUPO ${nivel} (${apisEnGrupo.length} APIs en paralelo)`);
    
    // Ejecutar todas las APIs del grupo en paralelo
    await Promise.all(
      apisEnGrupo.map(async ({ apiName, apiConfig }) => {
        console.log(`🚀 Procesando API: ${apiName} [Grupo ${nivel}]`);
        console.log(`📁 Carpeta: ${apiConfig.carpeta_archivos}`);

        apiConfig.url = `${config.base_url}${apiConfig.endpoint}`;
        await procesarCarpeta(apiConfig, token, nivel);
      })
    );
    
    console.log(`✅ Grupo ${nivel} completado\n`);
  }

  console.log("✅ Todos los envíos completados.");
}
ejecutar().catch((err) => console.error("Error general:", err));
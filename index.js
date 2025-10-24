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
  // console.log(config.auth_data);
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

async function procesarArchivo(apiConfig, archivo, token, indiceEnvio = 1) {
  const rutaArchivo = path.join(apiConfig.carpeta_archivos, archivo);
  const nombreArchivo = path.parse(archivo).name;
  const ext = path.parse(archivo).ext.toLowerCase();
  const carpetaSalida =
    apiConfig.carpeta_respuestas || apiConfig.carpeta_archivos;
  await fs.ensureDir(carpetaSalida);

  const headersBase = { Authorization: `Bearer ${token}` };

  async function guardar(pathDestino, obj) {
    await fs.writeFile(pathDestino, JSON.stringify(obj, null, 2), "utf8");
  }

  try {

    if (ext === ".xml") {
      const posibleJson = path.join(
        apiConfig.carpeta_archivos,
        `${nombreArchivo}.json`
      );
      if (await fs.pathExists(posibleJson)) {
        console.log(
          `ℹ️ Saltando ${archivo} porque existe ${nombreArchivo}.json (se procesará desde el .json)`
        );
        return;
      }
    }

    let bodyToSend = null;
    let finalHeaders = { ...headersBase, "Content-Type": "application/json" };

    if (ext === ".json") {
      const jsonRaw = await fs.readFile(rutaArchivo, "utf8");
      let jsonObj;
      try {
        jsonObj = JSON.parse(jsonRaw);
      } catch (e) {
        jsonObj = { raw: jsonRaw };
      }
      const xmlPath = path.join(
        apiConfig.carpeta_archivos,
        `${nombreArchivo}.xml`
      );
      const hasXml = await fs.pathExists(xmlPath);
      let xmlBase64 = null;
      if (hasXml) {
        const xmlData = await fs.readFile(xmlPath, "utf8");
        xmlBase64 = Buffer.from(xmlData, "utf8").toString("base64");
      }
      var payload;
      if (!apiConfig.endpoint.toLowerCase().includes("consultarcuv")) {
        payload = { rips: jsonObj };
      } else {
        payload = jsonObj;
      }
      if (hasXml) payload.xmlFevFile = xmlBase64;

      bodyToSend = JSON.stringify(payload);
    } else if (ext === ".xml") {
      const xmlData = await fs.readFile(rutaArchivo, "utf8");
      const xmlBase64 = Buffer.from(xmlData, "utf8").toString("base64");

      payload = { xmlFevFile: xmlBase64 };
      bodyToSend = JSON.stringify(payload);
    } else {
      const data = await fs.readFile(rutaArchivo);
      bodyToSend = data;
    }

    console.log(`🚀 Enviando ${archivo} -> ${bodyToSend} ...`);

    // --- ENVÍO ---
    console.log("url", apiConfig);
    console.log("body", payload);
    console.log("headers", finalHeaders);
    finalHeaders["Content-Type"] = "application/json";
    const res = await axios.post(apiConfig.url, payload, {
      headers: finalHeaders,
    });
    console.log(res);
    const sufijo = `_envio${indiceEnvio}`;
    const responsePath = path.join(
      carpetaSalida,
      `${nombreArchivo}${sufijo}_res.txt`
    );
    //console.log(res.body);
    await guardar(responsePath, res.data);
    console.log(`✅ Enviado: ${archivo} -> ${responsePath}`);
  } catch (err) {
    console.log(err);
    const sufijo = `_envio${indiceEnvio}`;
    // --- MANEJO DE ERROR ---
    const errorPath = path.join(
      carpetaSalida,
      `${nombreArchivo}${sufijo}_res_error.txt`
    );
    let responseBody = null;
    if (err.response) {
      // Si el body viene como objeto, se deja tal cual; si es texto, se convierte en string.
      if (typeof err.response.data === "object") {
        responseBody = err.response.data;
      } else {
        responseBody = { rawBody: String(err.response.data) };
      }
    }
    await guardar(errorPath, responseBody);
    console.error(`❌ Error enviando ${archivo}: ${responseBody}`);
    console.log(`⚠️  Detalle guardado en: ${errorPath}`);
  }
}

async function ejecutar() {
  const config = await loadConfig();
  const token = await obtenerToken(config);

  for (const [apiName, apiConfig] of Object.entries(config.apis)) {
    console.log(`🚀 Procesando API: ${apiName}`);

    const archivos = (await fs.readdir(apiConfig.carpeta_archivos)).filter(
      (f) => f.endsWith(".json") || f.endsWith(".xml")
    );

    apiConfig.url = `${config.base_url}${apiConfig.endpoint}`;
    const repeticiones = Number(apiConfig.concurrencia) || 1;

    const concurr = Number(apiConfig.concurrencia) || 1;
    const limit = pLimit(concurr);
    const tareas = archivos.flatMap((a) =>
      Array.from({ length: concurr }, (_, i) =>
        limit(async () => {
          const indiceEnvio = i + 1;
          console.log(
            `▶️ [${apiName}] Envío ${indiceEnvio}/${concurr} de ${a}`
          );
          await procesarArchivo(apiConfig, a, token, indiceEnvio);
        })
      )
    );

    await Promise.all(tareas);
  }

  console.log("✅ Todos los envíos completados.");
}

ejecutar().catch((err) => console.error("Error general:", err));

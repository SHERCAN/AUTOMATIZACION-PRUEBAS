use serde::{Deserialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub base_url: String,
    pub auth_endpoint: String,
    pub auth_data: serde_json::Value,
    pub apis: HashMap<String, ApiConfig>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ApiConfig {
    pub endpoint: String,
    pub carpeta_archivos: String,
    pub concurrencia: Option<u8>,
    pub comprimir: Option<bool>,
}
// build.rs
fn main() {
    // Solo en Windows se compila el .rc
    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("icon.ico");
        res.compile().unwrap();
    }
}
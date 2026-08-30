#[cfg(feature = "app")]
fn main() {
    tauri_build::build();
}

#[cfg(not(feature = "app"))]
fn main() {}

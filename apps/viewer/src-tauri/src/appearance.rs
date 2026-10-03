//! View ▸ Appearance in the native menu bar: System, Light or Dark. The choice
//! sets the window's theme, which the webview's `prefers-color-scheme` (and so
//! every style) follows, and is remembered in the app's settings store.
use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItemKind, Submenu};
use tauri::{AppHandle, Manager, Runtime, Theme, Wry};
use tauri_plugin_store::StoreExt;

const SETTINGS_FILE: &str = "settings.json";
const APPEARANCE_KEY: &str = "appearance";
const ID_PREFIX: &str = "appearance:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

impl Appearance {
    pub const ALL: [Appearance; 3] = [Appearance::System, Appearance::Light, Appearance::Dark];

    fn label(self) -> &'static str {
        match self {
            Appearance::System => "System",
            Appearance::Light => "Light",
            Appearance::Dark => "Dark",
        }
    }

    fn accelerator(self) -> Option<&'static str> {
        match self {
            Appearance::System => None,
            Appearance::Light => Some("Shift+CmdOrCtrl+L"),
            Appearance::Dark => Some("Shift+CmdOrCtrl+D"),
        }
    }

    /// The window theme: `None` follows the operating system.
    pub fn theme(self) -> Option<Theme> {
        match self {
            Appearance::System => None,
            Appearance::Light => Some(Theme::Light),
            Appearance::Dark => Some(Theme::Dark),
        }
    }

    pub fn menu_id(self) -> String {
        format!("{ID_PREFIX}{}", self.key())
    }

    fn key(self) -> &'static str {
        match self {
            Appearance::System => "system",
            Appearance::Light => "light",
            Appearance::Dark => "dark",
        }
    }

    /// The appearance a menu item id stands for, if it is one of ours.
    pub fn from_menu_id(id: &str) -> Option<Appearance> {
        let key = id.strip_prefix(ID_PREFIX)?;
        Appearance::ALL.into_iter().find(|a| a.key() == key)
    }
}

/// The saved appearance; anything unreadable falls back to System.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Appearance {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|s| s.get(APPEARANCE_KEY))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn save<R: Runtime>(app: &AppHandle<R>, appearance: Appearance) {
    if let Ok(store) = app.store(SETTINGS_FILE) {
        store.set(APPEARANCE_KEY, serde_json::json!(appearance));
        let _ = store.save();
    }
}

/// The app's menu: the platform default plus View ▸ Appearance.
pub fn build_menu(app: &AppHandle<Wry>, current: Appearance) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    let items = Appearance::ALL
        .into_iter()
        .map(|a| {
            CheckMenuItem::with_id(
                app,
                a.menu_id(),
                a.label(),
                true,
                a == current,
                a.accelerator(),
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = items.iter().map(|i| i as _).collect();
    let appearance = Submenu::with_items(app, "Appearance", true, &refs)?;
    match find_submenu(&menu, "View")? {
        Some(view) => view.prepend(&appearance)?,
        None => {
            let view = Submenu::with_items(app, "View", true, &[&appearance])?;
            menu.append(&view)?;
        }
    }
    Ok(menu)
}

fn find_submenu(menu: &Menu<Wry>, title: &str) -> tauri::Result<Option<Submenu<Wry>>> {
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item
            && sub.text()? == title
        {
            return Ok(Some(sub));
        }
    }
    Ok(None)
}

/// Apply a choice: tick it in the menu, theme every window, and remember it.
pub fn apply(app: &AppHandle<Wry>, appearance: Appearance) {
    if let Some(menu) = app.menu() {
        for a in Appearance::ALL {
            if let Some(MenuItemKind::Check(item)) = menu
                .get(&a.menu_id())
                .or_else(|| find_in_submenus(&menu, &a.menu_id()))
            {
                let _ = item.set_checked(a == appearance);
            }
        }
    }
    for window in app.webview_windows().values() {
        let _ = window.set_theme(appearance.theme());
    }
    save(app, appearance);
}

fn find_in_submenus(menu: &Menu<Wry>, id: &str) -> Option<MenuItemKind<Wry>> {
    fn search(items: Vec<MenuItemKind<Wry>>, id: &str) -> Option<MenuItemKind<Wry>> {
        for item in items {
            if item.id() == id {
                return Some(item);
            }
            if let MenuItemKind::Submenu(sub) = &item
                && let Some(found) = sub.items().ok().and_then(|inner| search(inner, id))
            {
                return Some(found);
            }
        }
        None
    }
    search(menu.items().ok()?, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_ids_round_trip() {
        for a in Appearance::ALL {
            assert_eq!(Appearance::from_menu_id(&a.menu_id()), Some(a));
        }
        assert_eq!(Appearance::from_menu_id("appearance:sepia"), None);
        assert_eq!(Appearance::from_menu_id("quit"), None);
    }

    #[test]
    fn system_follows_the_os_and_the_others_force_a_theme() {
        assert_eq!(Appearance::System.theme(), None);
        assert_eq!(Appearance::Light.theme(), Some(Theme::Light));
        assert_eq!(Appearance::Dark.theme(), Some(Theme::Dark));
    }

    #[test]
    fn saved_value_is_lowercase_and_defaults_to_system() {
        assert_eq!(
            serde_json::json!(Appearance::Dark),
            serde_json::json!("dark")
        );
        assert_eq!(
            serde_json::from_value::<Appearance>(serde_json::json!("light")).unwrap(),
            Appearance::Light
        );
        assert!(serde_json::from_value::<Appearance>(serde_json::json!("sepia")).is_err());
        assert_eq!(Appearance::default(), Appearance::System);
    }
}

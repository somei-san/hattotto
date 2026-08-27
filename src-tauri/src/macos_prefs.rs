// ── macOS User Defaults ─────────────────────────────────────

/// アプリ起動時に一度だけ呼ぶ。キーの長押しをこのアプリに限って「押しっぱなしでリピート」
/// にする（macOS 既定の press-and-hold アクセントポップアップを止める）。
///
/// `setBool:forKey:` ではなく `registerDefaults:` を使う。`registerDefaults:` は検索リストの
/// 最下位（NSRegistrationDomain）に値を積むだけで plist に書き込まれないため、他アプリや
/// システム全体の設定には影響せず、次回起動時は自動的にこの登録からやり直しになる
/// （つまり永続化されない）。
#[cfg(target_os = "macos")]
pub fn disable_press_and_hold() {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str("ApplePressAndHoldEnabled");
    let value = NSNumber::new_bool(false);
    let dict: objc2::rc::Retained<NSDictionary<NSString, AnyObject>> =
        NSDictionary::from_slices(&[&*key], &[value.as_ref()]);
    // SAFETY: `registerDefaults:` は AnyObject に property list 型を要求する。
    // 渡す値は NSNumber(bool) なのでこれを満たす
    unsafe {
        defaults.registerDefaults(&dict);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn disable_press_and_hold() {}

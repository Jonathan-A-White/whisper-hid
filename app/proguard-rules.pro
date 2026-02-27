# Keep Bluetooth HID classes
-keep class android.bluetooth.** { *; }

# Keep all classes in our package (no obfuscation needed for sideloaded debug APK)
-keep class com.whisperbt.keyboard.** { *; }

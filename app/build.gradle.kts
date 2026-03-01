plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun gitVersionName(): String {
    return try {
        val count = providers.exec { commandLine("git", "rev-list", "--count", "HEAD") }
            .standardOutput.asText.get().trim()
        val hash = providers.exec { commandLine("git", "rev-parse", "--short", "HEAD") }
            .standardOutput.asText.get().trim()
        "1.0.$count+$hash"
    } catch (_: Exception) {
        "1.0.0-dev"
    }
}

android {
    namespace = "com.whisperbt.keyboard"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.whisperbt.keyboard"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = gitVersionName()
        buildConfigField("String", "APP_VERSION", "\"${gitVersionName()}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    testImplementation("junit:junit:4.13.2")
}

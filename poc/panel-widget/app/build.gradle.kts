plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.conselit.cockpit.widget"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.conselit.cockpit.widget.poc"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "poc-3"
    }

    // The POC's own debug key (the workflow makes it once), so each build installs over the last.
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
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
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.core:core-ktx:1.13.1")
}

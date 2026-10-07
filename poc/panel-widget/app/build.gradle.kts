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
        versionCode = 1
        versionName = "poc"
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

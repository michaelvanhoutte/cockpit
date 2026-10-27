plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// A release is cut from a tag `widget-v1.2.3` (.github/workflows/widget-release.yml),
// which passes the name and a code that grows with it. A local build is 0.0.0-dev.
val widgetVersionName = (findProperty("widgetVersionName") as String?) ?: "0.0.0-dev"
val widgetVersionCode = ((findProperty("widgetVersionCode") as String?) ?: "1").toInt()

android {
    namespace = "com.conselit.cockpit.widget"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.conselit.cockpit.widget"
        minSdk = 26
        targetSdk = 35
        versionCode = widgetVersionCode
        versionName = widgetVersionName
    }

    // Two builds that install side by side, each fixed to the one origin it reads
    // and signs in to. They differ in the address the sign-in returns to as well:
    // two apps claiming one private scheme would be asked "open with" on the way back.
    flavorDimensions += "environment"
    productFlavors {
        create("production") {
            dimension = "environment"
            buildConfigField("String", "ORIGIN", "\"https://cockpit.vanhoutte-michael.workers.dev\"")
            buildConfigField("String", "REDIRECT_URI", "\"cockpit-widget://oauth\"")
            manifestPlaceholders["redirectScheme"] = "cockpit-widget"
            resValue("string", "app_name", "Cockpit widget")
        }
        create("staging") {
            dimension = "environment"
            applicationIdSuffix = ".staging"
            versionNameSuffix = "-staging"
            buildConfigField("String", "ORIGIN", "\"https://cockpit-staging.vanhoutte-michael.workers.dev\"")
            buildConfigField("String", "REDIRECT_URI", "\"cockpit-widget-staging://oauth\"")
            manifestPlaceholders["redirectScheme"] = "cockpit-widget-staging"
            resValue("string", "app_name", "Cockpit widget (staging)")
        }
    }

    // The release key is a GitHub secret the owner holds (docs/deployment.md, "The
    // Android widget"); without it a release build is left unsigned rather than
    // signed with a key that is not the one phones will check updates against.
    val keystorePath = System.getenv("WIDGET_KEYSTORE_PATH")
    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("WIDGET_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("WIDGET_KEY_ALIAS")
                keyPassword = System.getenv("WIDGET_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        // Resolving a lint check's own dependencies offline is not what it is for.
        checkDependencies = false
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all {
                // The tests answer from the sample files the server's own tests hold
                // its real answers to, read from the repository and never copied.
                it.systemProperty("cockpit.samples", rootProject.projectDir.resolve("../../packages/shared/samples").canonicalPath)
            }
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.work:work-runtime:2.9.1")
    implementation("androidx.browser:browser:1.8.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation("androidx.work:work-testing:2.9.1")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

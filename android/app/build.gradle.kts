plugins {
    id("com.android.application")
}

android {
    namespace = "app.tripguide"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.tripguide"
        minSdk = 26
        targetSdk = 34
        versionCode = 5
        versionName = "0.5"
    }

    // Постоянный ключ подписи: с ним новые версии ставятся поверх старой без потери данных.
    signingConfigs {
        create("release") {
            storeFile = file("../keystore/tripguide.jks")
            storePassword = "tripguide"
            keyAlias = "tripguide"
            keyPassword = "tripguide"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    // Веб-приложение из ../../docs (оно же сайт на GitHub Pages) кладём в assets как запасную копию.
    sourceSets["main"].assets.srcDirs("../../docs")

    lint {
        checkReleaseBuilds = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}

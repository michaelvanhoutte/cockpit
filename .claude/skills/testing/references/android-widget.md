# The Android widget

Open this for a test of the home-screen widget (`apps/android-widget`, Kotlin, built by Gradle, no pnpm package), the one part of Cockpit that is not TypeScript. The rules every test follows are in [SKILL.md](../SKILL.md).

It has two levels of its own, both run by `./gradlew testStagingDebugUnitTest` in CI's `Widget` job, which runs only when a file it reads changes:

| Level | What runs | Proves |
|---|---|---|
| **A1** | a Kotlin unit test on the JVM: no Android, no network | the app's own rules and arithmetic: the due pill, the *Updated* line, the addresses a tap opens, the sign-in's PKCE and redirect checks, and that a field it does not know changes nothing |
| **A2** | Robolectric's simulated Android runs the app's real code against a fake Cockpit at the network boundary (OkHttp's MockWebServer), answering with the sample files in `packages/shared/samples/`, read from the repository and never copied | the app and its widget's views agree with the server: sign-in, the picker, what a widget draws, each answer of a refresh, the scheduling, sign-out |

**The sample files are the contract between server and app.** The server's tests hold its real answers to them and the app's tests are answered from them, so a change to an answer that breaks the app fails a test on one side or the other.

**There is no emulator tier**, since it costs minutes a run and is flaky at placing widgets, for code that rarely changes. **The proof that the widget works for a person is the owner's walk on a real phone**, written in the pull request as a `Real device: <device> - <what happened>` line, which `/build` holds the pull request on until it has a result. That replaces the definition of done's browser pass, there being no browser to drive.

**Robolectric runs Android 14 (API 34)**, because its newer Android needs a newer Java than CI and a developer machine have.

**Naming follows SKILL.md's "Name it after the product, not the mechanism" as far as JUnit allows:** the class is the rule, kept short because the build's paths are limited on Windows, and its doc comment names the feature area, *Home-screen widget*; each method is a case in product language. The test explorer reads TypeScript only, so the area is registered in `tools/test-explorer/concepts.json` with no source patterns and no browser walks.

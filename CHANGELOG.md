## [1.0.2](https://github.com/mderdzinski/smokescreen/compare/v1.0.1...v1.0.2) (2026-07-02)


### Bug Fixes

* **ci:** create GitHub Releases from semantic-release tags ([feffafc](https://github.com/mderdzinski/smokescreen/commit/feffafc63872aff941dd9eec5addb24b4e3fed21))

## [1.0.1](https://github.com/mderdzinski/smokescreen/compare/v1.0.0...v1.0.1) (2026-07-02)


### Bug Fixes

* **ci:** use workflow variables for public WIF identifiers ([53b494f](https://github.com/mderdzinski/smokescreen/commit/53b494f67651480a1a0e5ca4ebbc19dff1774c69))

# 1.0.0 (2026-07-02)


### Bug Fixes

* add Docker build gate ([94519ff](https://github.com/mderdzinski/smokescreen/commit/94519ffdd416261108f212f64854389ff9480d4b))
* align needs attention statuses ([02d4b36](https://github.com/mderdzinski/smokescreen/commit/02d4b36d55be0f90f0d9a1b2ab53c86582438306))
* allow initial identity request poll replies (sm-0e1) ([ed43170](https://github.com/mderdzinski/smokescreen/commit/ed431708f30bb8f78b8b0eb839f95797cb4a0c30))
* avoid claude ready wording ([6324ee0](https://github.com/mderdzinski/smokescreen/commit/6324ee0abac7aab658db35c9be7e5026d31d8174))
* dedupe pending whitelist requests ([dd99c1a](https://github.com/mderdzinski/smokescreen/commit/dd99c1ac69164fdcaa95f37f8b2041179833d08b))
* handle empty outreach broker selection (sm-3lm) ([979d476](https://github.com/mderdzinski/smokescreen/commit/979d47684f424a34467e980fae60b766679c0565))
* honor poll label in thread polling ([d8a2056](https://github.com/mderdzinski/smokescreen/commit/d8a20562cabd652c46793845cb958c2970e5af46))
* persist manual review broker replies ([e3d9030](https://github.com/mderdzinski/smokescreen/commit/e3d903013b28e86296ec7d25a067399a47410f91))
* reject infra settings updates (sm-am3) ([a744e68](https://github.com/mderdzinski/smokescreen/commit/a744e6891fc04b82eebe05fd6905138130088e3f))
* resolve ruff lint gate (sm-45a) ([d3911ff](https://github.com/mderdzinski/smokescreen/commit/d3911ff4f6f0783ae1a92b8b0c063426bf78cf4d))
* return 404 for old dashboard route ([a8a6944](https://github.com/mderdzinski/smokescreen/commit/a8a69443c820caf2c99fdb5fe6dc755d54892c54))
* separate Gmail connection from identity (sm-er1) ([a5ec044](https://github.com/mderdzinski/smokescreen/commit/a5ec044c491cdc234def31726e2157f98d3884b3))
* split settings API surface (sm-ui-settings-api) ([91d7650](https://github.com/mderdzinski/smokescreen/commit/91d765059b8baaee189df86c5121cdeedf89ddd0))
* surface Gmail setup outreach errors (sm-0yq) ([51c7730](https://github.com/mderdzinski/smokescreen/commit/51c773019be2f3286dff7e89455bc25fc8b63549))
* validate cloud run iap terraform wiring ([eeb0518](https://github.com/mderdzinski/smokescreen/commit/eeb05181d35c4e250866106bc649144cd18c195e))
* wire cloud run gmail oauth secrets ([390cafb](https://github.com/mderdzinski/smokescreen/commit/390cafbda3a694d540bfcbb4afcced8fbddd059c))


### Features

* add consumer broker status landing (sm-ui-status) ([0032084](https://github.com/mderdzinski/smokescreen/commit/0032084fbfac306456ea515921a5b6de60dd0879))
* add CSV broker import, re-request scheduling, and dashboard stats ([7fad5dd](https://github.com/mderdzinski/smokescreen/commit/7fad5dd72c3dcded4b6a5f2a66d44045c929869f))
* add front-end dashboard with email whitelist system (sm-58k) ([ee6559e](https://github.com/mderdzinski/smokescreen/commit/ee6559ef0f0d47d7c74cb7d76fd5cbcd8560b080))
* add React async states (sm-ui-states) ([77dc67b](https://github.com/mderdzinski/smokescreen/commit/77dc67bc458a75881ceee37189278507d4cba52c))
* add React broker registry (sm-ui-registry) ([3926ea7](https://github.com/mderdzinski/smokescreen/commit/3926ea7db3cad864f81512d6342d3480892fc5e3))
* add release and docker publish CI (sm-0df) ([11db0de](https://github.com/mderdzinski/smokescreen/commit/11db0dedaf33c54194657e996446edc98ba319eb))
* add Settings configuration UI with JSON file persistence ([ad53807](https://github.com/mderdzinski/smokescreen/commit/ad53807cd6771df8403a106bbf70c5d241a9ff56))
* add src layout with empty smokescreen package ([2ae9544](https://github.com/mderdzinski/smokescreen/commit/2ae95443148709348bfbac97b50650d65c402f60))
* add tests directory with placeholder test ([0e4248f](https://github.com/mderdzinski/smokescreen/commit/0e4248f9d21c38c083813390d41afeeb76fa6155))
* cut over React dashboard to root ([188baea](https://github.com/mderdzinski/smokescreen/commit/188baea39e73a36e3f189d72c669c4518d87ca7c))
* guide needs attention reviews ([1c336a3](https://github.com/mderdzinski/smokescreen/commit/1c336a36d6bbf816f4bad2d06d3bd0bbbe48c9d1))
* initialize project with uv, ruff, pre-commit, and semantic commits ([c54b6ca](https://github.com/mderdzinski/smokescreen/commit/c54b6cab18f8c055d31c3756736977468b69df42))

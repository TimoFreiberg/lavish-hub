{
  description = "Workspace review hub for Lavish artifacts and jj diffs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          pkgJson = builtins.fromJSON (builtins.readFile ./package.json);
        in
        {
          default = pkgs.buildNpmPackage {
            pname = pkgJson.name;
            version = pkgJson.version;
            src = ./.;

            npmDepsHash = "sha256-B3foQ4TPFQjk1KQLwhEOscceU+D57VZwObcpC1EQpQw=";
            npmFlags = [
              "--ignore-scripts"
              "--legacy-peer-deps"
            ];
            makeCacheWritable = true;

            nativeBuildInputs = [ pkgs.makeWrapper ];

            buildPhase = ''
              runHook preBuild
              mkdir -p dist
              node build.mjs "$PWD" "$PWD/dist"
              ln -s "$PWD/node_modules" vendor/lavish/node_modules
              (
                cd vendor/lavish
                LAVISH_AXI_UMAMI_HOST="" LAVISH_AXI_UMAMI_WEBSITE_ID="" node scripts/build.js
              )
              rm vendor/lavish/node_modules
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              npm prune --omit=dev --ignore-scripts --legacy-peer-deps
              mkdir -p "$out/lib/lavish-hub" "$out/bin"
              cp -r package.json bin src web dist docs LICENSE "$out/lib/lavish-hub/"
              mkdir -p "$out/lib/lavish-hub/vendor/lavish"
              cp -r vendor/lavish/package.json vendor/lavish/dist vendor/lavish/LICENSE vendor/lavish/THIRD-PARTY-NOTICES.md "$out/lib/lavish-hub/vendor/lavish/"
              cp -r node_modules "$out/lib/lavish-hub/"
              makeWrapper "${pkgs.nodejs}/bin/node" "$out/bin/lavish-hub" \
                --add-flags "$out/lib/lavish-hub/bin/lavish-hub"
              runHook postInstall
            '';

            meta = {
              description = "Workspace review hub for Lavish artifacts and jj diffs";
              homepage = "https://github.com/TimoFreiberg/lavish-hub";
              license = pkgs.lib.licenses.mit;
              mainProgram = "lavish-hub";
            };
          };
        }
      );
    };
}

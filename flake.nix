{
  description = "Conquest — a Discord bot running a persistent, per-guild strategy game";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs @ {flake-parts, ...}:
    flake-parts.lib.mkFlake {inherit inputs;} {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem = {pkgs, ...}: {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # Runtime and package manager.
            nodejs_22
            pnpm

            # Editor / CLI tooling.
            typescript
            typescript-language-server

            # Inspecting the game database by hand.
            sqlite

            # Fallback SVG rasterizer for the map, used when the napi
            # prebuilt binding will not load.
            resvg

            # node-gyp prerequisites for better-sqlite3's native build.
            python3
            pkg-config
          ];

          shellHook = ''
            echo "Conquest devShell — node $(node --version), pnpm $(pnpm --version)"
          '';
        };

        formatter = pkgs.alejandra;
      };
    };
}

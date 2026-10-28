# The checks (the backend's Rust suite and lint are e2ee-store's):
#
# - web-unit: the frontend's Node unit tests, against the web package, so with the SDK it ships.
# - e2e-playback, e2e-upload, e2e-library: the browser tests, on e2ee-store's harness. The backend package behind
#   socat (as the iroh shim reaches it) serves the web package; Chromium with a PRF-capable virtual authenticator plays
#   a track through the Service Worker. A sandboxed build, not a VM: it needs no network.
# - vm: the NixOS module in a VM (./tests/lib.nix), on `machineModules`.
# - e2ee-store-sdk-unit, e2ee-store-browser, e2ee-store-vm-s3: e2ee-store's own, the ones it has an app rerun with
#   the app's nixpkgs (its nix/tests/default.nix), the VM test on `machineModules` as well.
#
# `machineModules` are the machine the VM tests boot: a minimal one here, the host's real configuration when a host
# repository runs these (./tests/default.nix).
{
  pkgs,
  backend,
  sdk,
  web,
  machineModules,
}:
let
  inherit (pkgs) lib;
  fileset = lib.fileset;
  static = "${web}/share/media-store/web";

  unitTests = fileset.toSource {
    root = ../web/test/unit;
    fileset = ../web/test/unit;
  };

  e2eTests = fileset.toSource {
    root = ../web/test/e2e;
    fileset = ../web/test/e2e;
  };

  python = pkgs.python3.withPackages (p: [ p.playwright ]);

  browserTest =
    name: script:
    pkgs.runCommand "media-store-${name}"
      {
        nativeBuildInputs = [
          python
          pkgs.chromium
          pkgs.socat
        ];
        BACKEND_BIN = lib.getExe backend;
        STATIC_DIR = static;
        PYTHONPATH = "${sdk}/share/e2ee-store/testing";
        PYTHONDONTWRITEBYTECODE = "1";
        # Chromium looks for fonts even headless; without a config it warns on every start.
        FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
      }
      ''
        export HOME="$TMPDIR"
        python ${e2eTests}/${script}
        touch "$out"
      '';
in
{
  # The tests find the app relative to themselves (../../public), so rebuild that layout.
  web-unit =
    pkgs.runCommand "media-store-web-unit"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        mkdir -p web/test
        cp -r ${static} web/public
        cp -r ${unitTests} web/test/unit
        cd web
        node --test "test/unit/**/*.test.js"
        touch "$out"
      '';

  e2e-playback = browserTest "e2e-playback" "test_playback.py";
  e2e-upload = browserTest "e2e-upload" "test_upload.py";
  e2e-library = browserTest "e2e-library" "test_library.py";

  vm = import ./tests/lib.nix { inherit pkgs machineModules; };
}
// lib.mapAttrs' (name: check: lib.nameValuePair "e2ee-store-${name}" check) (
  import (import ./e2ee-store.nix + "/nix/tests") { inherit pkgs backend machineModules; }
)

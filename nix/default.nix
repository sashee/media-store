# Entry point: `nix-build nix` builds both packages and runs every check.
#
#   nix-build nix                          # packages + all checks (what CI runs)
#   nix-build nix -A backend               # e2ee-store's backend (its doCheck runs the Rust suite)
#   nix-build nix -A sdk                   # e2ee-store's SDK and browser-test harness
#   nix-build nix -A web                   # the frontend's static files, with the SDK inside
#   nix-build nix -A checks.web-unit       # the frontend's unit tests
#   nix-build nix -A checks.e2e-playback   # a browser test (also e2e-upload)
#   nix-build nix -A checks.vm             # the NixOS module (./module.nix) in a VM
#   nix-build nix -A checks.e2ee-store-sdk-unit   # e2ee-store's checks an app reruns (also e2ee-store-browser,
#                                                 # e2ee-store-vm-s3)
#
# No flake, like the sibling repositories: the packages are callPackage functions and take the caller's
# nixpkgs, so the one choice of nixpkgs lives in ./pkgs.nix (a branch, not a pin). e2ee-store is pinned in
# ./e2ee-store.nix.
{
  pkgs ? import ./pkgs.nix { },
}:
let
  e2eeStore = import ./e2ee-store.nix;
  backend = pkgs.callPackage (e2eeStore + "/backend/package.nix") { };
  sdk = pkgs.callPackage (e2eeStore + "/sdk/package.nix") { };
  web = pkgs.callPackage ../web/package.nix { inherit sdk; };
  checks = import ./checks.nix {
    inherit
      pkgs
      backend
      sdk
      web
      ;
    machineModules = [ { system.stateVersion = pkgs.lib.trivial.release; } ];
  };
in
pkgs.symlinkJoin {
  name = "media-store";
  paths = [
    backend
    web
  ];
  # Interpolating each check registers it as a build input, so this only builds when every check passes.
  postBuild = ''
    : ${pkgs.lib.concatStringsSep " " (map toString (builtins.attrValues checks))}
  '';
  passthru = {
    inherit
      backend
      sdk
      web
      checks
      ;
  };
}

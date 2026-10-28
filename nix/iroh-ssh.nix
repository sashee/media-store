# The iroh tunnel tools (iroh-uds-listen etc.) from sashee/nixos-test, pinned to a commit, built with this
# repository's nixpkgs. Only for development: `make iroh` exposes the backend's socket over iroh.
{
  pkgs ? import ./pkgs.nix { },
}:
let
  nixosTest = fetchTarball "https://github.com/sashee/nixos-test/archive/898042c213814d474891ad24358fef7b6cf823d9.tar.gz";
in
pkgs.callPackage "${nixosTest}/packages/iroh-ssh/package.nix" { }

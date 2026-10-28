# Every check, for a host repository: media-store's and the e2ee-store ones it reruns (../checks.nix), built with the
# host's nixpkgs, and the VM tests booting the host's real configuration:
#
#   import "${media-store}/nix/tests" { inherit pkgs; machineModules = [ <host config> ]; }
#
# An attrset of derivations, one per check, so a host maps them into its own check sets and gets new ones without
# editing anything.
{
  pkgs,
  machineModules,
}:
let
  e2eeStore = import ../e2ee-store.nix;
  sdk = pkgs.callPackage (e2eeStore + "/sdk/package.nix") { };
in
import ../checks.nix {
  inherit pkgs sdk machineModules;
  backend = pkgs.callPackage (e2eeStore + "/backend/package.nix") { };
  web = pkgs.callPackage ../../web/package.nix { inherit sdk; };
}

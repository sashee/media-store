# Development shell: `nix-shell` at the repository root.
{
  pkgs ? import ./nix/pkgs.nix { },
}:
pkgs.mkShell {
  packages = [
    # local serving: socat forwards a loopback port to the backend's socket
    pkgs.socat
    # frontend unit tests
    pkgs.nodejs
    # end-to-end tests: Playwright drives Nix's Chromium
    (pkgs.python3.withPackages (p: [ p.playwright ]))
    pkgs.chromium
    pkgs.gnumake
  ];
  # Chromium looks for fonts even headless; without a config it warns on every start.
  FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
}

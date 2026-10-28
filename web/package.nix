# The media library's frontend: the static files the backend serves from `static_dir`. There is no build
# step, so this is a copy of web/public at $out/share/media-store/web, with e2ee-store's SDK at its sdk/.
{
  lib,
  runCommand,
  sdk,
}:
let
  public = lib.fileset.toSource {
    root = ./public;
    # web/public/sdk is only the development link to the SDK (`make deps`).
    fileset = lib.fileset.difference ./public (lib.fileset.maybeMissing ./public/sdk);
  };
in
runCommand "media-store-web" { } ''
  mkdir -p "$out/share/media-store"
  cp -r ${public} "$out/share/media-store/web"
  chmod u+w "$out/share/media-store/web"
  cp -r ${sdk}/share/e2ee-store/sdk "$out/share/media-store/web/sdk"
''

// The HTML base is supplied by the reverse proxy's configured root_path.
export function appPath(path='/') {
  const target=new URL(path.replace(/^\//,''),document.baseURI);
  return target.pathname+target.search+target.hash;
}

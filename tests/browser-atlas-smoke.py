"""GPU regression: an atlas face must never sample its differently colored neighbor."""
import argparse
import importlib.util
import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

spec = importlib.util.spec_from_file_location('animation_smoke', Path(__file__).with_name('browser-animation-smoke.py'))
animation_smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(animation_smoke)

SETUP = r'''async () => {
  const T=await import('./three.module.min.js');
  const app=await import('./ysm-three-renderer.js');
  const qa=window.qa={T,app};
  const original=T.Mesh.prototype.onBeforeRender;
  T.Mesh.prototype.onBeforeRender=function(renderer,scene,camera,...rest){
    Object.assign(qa,{renderer,scene,camera});
    T.Mesh.prototype.onBeforeRender=original;
    return original.call(this,renderer,scene,camera,...rest);
  };
  app.init('three-canvas'); app.setViewportRect(0,0,512,512);
  app.loadModelGeometry(JSON.stringify({models:[{id:'atlas',textureId:'atlas-texture',bones:[],meshGroups:[{
    id:'face',positions:[-1,-1,0, 1,-1,0, 1,1,0, -1,1,0],
    normals:[0,0,1, 0,0,1, 0,0,1, 0,0,1],
    uvs:[0.25,0.25, 0.75,0.25, 0.75,0.75, 0.25,0.75],indices:[0,1,2,0,2,3]
  }]}]}));
}'''

TEXTURE = r'''async kind => {
  const {app,scene}=window.qa, canvas=document.createElement('canvas');
  canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');
  if(kind==='atlas'){
    ctx.fillStyle='#00ff00';ctx.fillRect(0,0,64,64);
    ctx.fillStyle='#ff0000';ctx.fillRect(16,16,32,32);
  }else{
    ctx.clearRect(0,0,64,64);
    ctx.fillStyle='rgba(255,0,0,0.5)';ctx.fillRect(21,0,22,64);
    ctx.fillStyle='#ff0000';ctx.fillRect(43,0,21,64);
  }
  let mesh;scene.traverse(o=>{if(o.name==='face')mesh=o;});
  window.qa.previousTexture=mesh.material.map;
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  app.addTextureData('atlas-texture',new Uint8Array(await blob.arrayBuffer()));
}'''

RENDER_ATLAS = r'''angle => {
  const {T,renderer,scene,camera}=window.qa;
  let mesh;scene.traverse(o=>{if(o.name==='face')mesh=o;});
  mesh.rotation.set(0.29,0.19,angle);mesh.position.set(0.013,-0.017,0);
  camera.position.set(0,0,3.5);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
  scene.background=new T.Color(0x0000ff);renderer.render(scene,camera);
  const gl=renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
  const pixels=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  let neighborPixels=0,redPixels=0,antialiasedPixels=0;
  for(let i=0;i<pixels.length;i+=4){
    if(pixels[i+1]>2)neighborPixels++;
    if(pixels[i]>250 && pixels[i+1]<3 && pixels[i+2]<3)redPixels++;
    if(pixels[i]>3 && pixels[i]<252 && pixels[i+2]>3 && pixels[i+2]<252)antialiasedPixels++;
  }
  return {angle,neighborPixels,redPixels,antialiasedPixels,
    antialias:gl.getContextAttributes().antialias,samples:gl.getParameter(gl.SAMPLES)};
}'''

RENDER_ALPHA = r'''() => {
  const {T,renderer,scene,camera}=window.qa;
  let mesh;scene.traverse(o=>{if(o.name==='face')mesh=o;});
  mesh.position.set(0,0,0);mesh.rotation.set(0,0,0);
  mesh.geometry.attributes.uv.array.set([0,0,1,0,1,1,0,1]);mesh.geometry.attributes.uv.needsUpdate=true;
  camera.position.set(0,0,3.5);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
  scene.background=new T.Color(0x0000ff);
  // A nearer opaque surface must remain in front of the textured face, even
  // when the transparent render list is processed after the opaque list.
  const blocker=new T.Mesh(new T.PlaneGeometry(0.2,0.2),new T.MeshBasicMaterial({color:0x00ff00}));
  blocker.position.set(0.65,0.55,0.1);scene.add(blocker);
  renderer.render(scene,camera);
  const gl=renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
  const sample=(x,y,z=0)=>{
    const p=new T.Vector3(x,y,z).project(camera),pixel=new Uint8Array(4);
    gl.readPixels(Math.floor((p.x+1)*w/2),Math.floor((p.y+1)*h/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    return Array.from(pixel);
  };
  const result={clear:sample(-0.65,0),partial:sample(0,0),opaque:sample(0.65,0),occluded:sample(0.65,0.55,0.1)};
  scene.remove(blocker);blocker.geometry.dispose();blocker.material.dispose();
  mesh.geometry.attributes.uv.array.set([0.25,0.25,0.75,0.25,0.75,0.75,0.25,0.75]);mesh.geometry.attributes.uv.needsUpdate=true;
  return result;
}'''


def ready_texture(page, kind):
    page.evaluate(TEXTURE, kind)
    page.wait_for_function('''() => {
      let mesh;qa.scene.traverse(o=>{if(o.name==='face')mesh=o;});
      return mesh.material.map && mesh.material.map!==qa.previousTexture;
    }''')


def check_atlas(record):
    assert record['antialias'] and record['samples'] >= 2, 'MSAA must remain enabled'
    assert record['redPixels'] > 50000, 'The textured face must be visibly rendered'
    assert record['antialiasedPixels'] > 50, 'Smooth covered edges must remain visible'
    assert record['neighborPixels'] == 0, f"Sampled green texels outside the face UV rectangle: {record}"


def close_color(actual, expected):
    assert all(abs(a-b) <= 2 for a,b in zip(actual,expected)), f'Expected {expected}, got {actual}'


def run(base, baseline, output, channel):
    result={'success':False,'cases':[],'errors':[]}
    with sync_playwright() as pw:
        launch={'headless':True,'args':['--enable-unsafe-swiftshader']}
        if channel: launch['channel']=channel
        browser=pw.chromium.launch(**launch)
        try:
            result['browser']=browser.version
            for name in ['baseline','candidate']:
                page=browser.new_page(viewport={'width':512,'height':512},device_scale_factor=1)
                page.on('pageerror',lambda e:result['errors'].append(str(e)))
                page.on('console',lambda m:result['errors'].append(m.text) if m.type=='error' else None)
                page.route('**/__atlas-regression__.html',lambda route:route.fulfill(
                    content_type='text/html',body='<html><body style="margin:0"><canvas id="three-canvas"></canvas></body></html>'))
                if name=='baseline':
                    page.route('**/ysm-three-renderer.js',lambda route:route.fulfill(
                        content_type='text/javascript',body=baseline.read_text(encoding='utf-8')))
                page.goto(base+'viewer/__atlas-regression__.html')
                page.evaluate(SETUP)
                page.wait_for_function('!!window.qa?.renderer')
                ready_texture(page,'atlas')
                records=[page.evaluate(RENDER_ATLAS,a) for a in [0.11,0.37,0.81,1.27]]
                page.screenshot(path=str(output/(name+'-atlas.png')))
                record={'name':name,'atlas':records}
                result['cases'].append(record)
                if name=='baseline':
                    assert all(r['neighborPixels']>0 for r in records), 'Negative control did not reproduce atlas bleeding'
                else:
                    for r in records: check_atlas(r)
                ready_texture(page,'alpha')
                alpha=page.evaluate(RENDER_ALPHA);record['alpha']=alpha
                close_color(alpha['clear'],[0,0,255,255])
                # Preserve the pinned image decoder's existing partial-alpha
                # output; this change only adjusts where UVs are sampled.
                assert 0 < alpha['partial'][0] < 255
                close_color(alpha['partial'][1:],[0,127,255])
                if name=='candidate':
                    close_color(alpha['partial'],result['cases'][0]['alpha']['partial'])
                close_color(alpha['opaque'],[255,0,0,255])
                close_color(alpha['occluded'],[0,255,0,255])
                # Replacing a texture creates another material through the app.
                ready_texture(page,'atlas')
                replacement=page.evaluate(RENDER_ATLAS,0.37);record['replacement']=replacement
                if name=='candidate': check_atlas(replacement)
                print(json.dumps(record),flush=True)
                page.close()
            assert not result['errors'], result['errors']
            result['success']=True
        finally:
            browser.close()
            (output/'results.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({'success':True,'browser':result['browser'],'errors':result['errors']}),flush=True)


def main():
    parser=argparse.ArgumentParser()
    location=parser.add_mutually_exclusive_group(required=True)
    location.add_argument('--dist',type=Path)
    location.add_argument('--url')
    parser.add_argument('--baseline',type=Path,required=True,help='Unchanged pinned renderer, retained before patching')
    parser.add_argument('--output',type=Path,default=Path('.vendor/atlas-smoke'))
    parser.add_argument('--browser-channel')
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    server=None
    try:
        if args.dist:
            server=ThreadingHTTPServer(('127.0.0.1',0),partial(animation_smoke.Handler,directory=str(args.dist.resolve())))
            threading.Thread(target=server.serve_forever,daemon=True).start()
            base=f'http://127.0.0.1:{server.server_port}/'
        else: base=args.url.rstrip('/')+'/'
        run(base,args.baseline,args.output,args.browser_channel)
    finally:
        if server: server.shutdown();server.server_close()


if __name__=='__main__': main()

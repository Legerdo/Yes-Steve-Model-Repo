"""Exercise the packaged WASM app on unchanged .ysm/.zip inputs before deployment."""
import argparse
import json
import math
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

INIT = r'''(() => {
  const qa=window.__animationSmoke={files:[]};
  for(const name of ['ysmLoadModelGeometry','ysmLoadAnimationData']) {
    let fn;
    Object.defineProperty(window,name,{configurable:true,get(){return fn;},set(value){fn=function(...args){
      if(name==='ysmLoadModelGeometry') qa.geometry=JSON.parse(args[0]);
      else qa.files.push(JSON.parse(args[0]));
      return value.apply(this,args);
    };}});
  }
})();'''

CAPTURE = r'''async () => {
  const T=await import('./three.module.min.js'), qa=window.__animationSmoke;
  qa.THREE=T;
  const world=T.Object3D.prototype.updateMatrixWorld;
  T.Object3D.prototype.updateMatrixWorld=function(...args){
    if(this.isScene) qa.scene=this;
    if(this.isCamera) qa.camera=this;
    const result=world.apply(this,args);
    if(qa.scene && qa.camera) T.Object3D.prototype.updateMatrixWorld=world;
    return result;
  };
  const update=T.AnimationMixer.prototype.update;
  T.AnimationMixer.prototype.update=function(...args){
    qa.mixer=this; T.AnimationMixer.prototype.update=update;
    return update.apply(this,args);
  };
  window.ysmPlayAnimation('walk');
}'''

SET_POSE = r'''async ({name,time}) => {
  const qa=window.__animationSmoke;
  qa.mixer.timeScale=1;
  window.ysmStopAnimation(); qa.scene.updateMatrixWorld(true); window.ysmResetCamera();
  window.ysmPlayAnimation(name);
  qa.mixer.setTime(time); qa.mixer.timeScale=0;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
}'''

MEASURE = r'''() => {
  const {THREE:T,scene,camera}=window.__animationSmoke;
  scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
  const bones=[], invalid=[], p=new T.Vector3(), projected=new T.Vector3();
  let vertices=0, finiteVertices=0, inFrame=0;
  scene.traverse(o=>{
    const values=[...o.position,...o.quaternion,...o.scale,...o.matrixWorld.elements];
    if(!values.every(Number.isFinite)) invalid.push(o.name);
    if(o.isGroup && o.userData?.boneId) bones.push({name:o.name,p:o.position.toArray(),q:o.quaternion.toArray(),s:o.scale.toArray()});
  });
  scene.traverseVisible(o=>{
    if(!o.isMesh) return;
    const attr=o.geometry.attributes.position;
    for(let i=0;i<attr.count;i++) {
      vertices++;
      p.fromBufferAttribute(attr,i).applyMatrix4(o.matrixWorld);
      if(![...p].every(Number.isFinite)) continue;
      finiteVertices++;
      projected.copy(p).project(camera);
      if([...projected].every(v=>Number.isFinite(v) && Math.abs(v)<=1.00001)) inFrame++;
    }
  });
  const cameraValues=[...camera.position,...camera.quaternion,...camera.matrixWorld.elements,
    ...camera.matrixWorldInverse.elements,...camera.projectionMatrix.elements];
  return {bones,invalid,vertices,finiteVertices,inFrame,cameraFinite:cameraValues.every(Number.isFinite),
    camera:cameraValues,progress:JSON.parse(window.ysmGetAnimationProgress())};
}'''


def assert_finite(measurement):
    assert not measurement['invalid'], f"Nonfinite scene nodes: {measurement['invalid']}"
    assert measurement['vertices'] > 0
    assert measurement['finiteVertices'] == measurement['vertices'], 'Nonfinite world-space vertices'
    assert measurement['cameraFinite'] and all(math.isfinite(v) for v in measurement['camera']), 'Nonfinite camera'
    for bone in measurement['bones']:
        for field in ['p','q','s']:
            assert all(math.isfinite(v) for v in bone[field]), f"Nonfinite {bone['name']}.{field}"


def assert_same_pose(actual, expected):
    assert len(actual) == len(expected)
    for a,b in zip(actual,expected):
        assert a['name'] == b['name']
        for field in ['p','q','s']:
            assert all(abs(x-y)<1e-5 for x,y in zip(a[field],b[field])), f"Pose did not reset: {a['name']}.{field}"


def run(base, revision, output, channel):
    errors, warnings, records = [], [], []
    success = False
    with sync_playwright() as pw:
        launch={'headless':True,'args':['--enable-unsafe-swiftshader']}
        if channel: launch['channel']=channel
        browser=pw.chromium.launch(**launch)
        page=browser.new_page(viewport={'width':1600,'height':1000},device_scale_factor=1)
        page.add_init_script(INIT)
        page.on('pageerror',lambda error: errors.append(str(error)))
        def on_console(message):
            if message.type=='error': errors.append(message.text)
            elif message.type=='warning' and ('[YSM-Three]' in message.text or 'THREE.' in message.text): warnings.append(message.text)
        page.on('console',on_console)
        try:
            with page.expect_event('framenavigated',predicate=lambda f:'/viewer/' in f.url) as navigation:
                page.goto(base,wait_until='domcontentloaded')
            frame=navigation.value
            catalog=page.request.get(base+'models.json').json()
            if revision: assert catalog['revision']==revision, 'Unexpected deployed catalog revision'
            print(json.dumps({'revision':catalog['revision'],'browser':browser.version}),flush=True)
            for model in ['Itsuki','Alexten22']:
                if model=='Alexten22':
                    with page.expect_event('framenavigated',predicate=lambda f:'/viewer/' in f.url and 'Alexten22_1.0.0' in f.url) as navigation:
                        page.locator('button.model-row').filter(has_text='Alexten22 1.0.0').first.click()
                    frame=navigation.value
                frame.wait_for_function('!!window.__animationSmoke.geometry && window.__animationSmoke.files.length>=2',timeout=60000)
                assert frame.evaluate("typeof window.ysmEvaluateMolang==='function' && typeof window.ysmSetMolangVariable==='function'"), 'Managed MoLang bridge missing'
                frame.evaluate(CAPTURE)
                frame.wait_for_function('!!window.__animationSmoke.camera && !!window.__animationSmoke.mixer',timeout=15000)
                frame.evaluate('window.ysmStopAnimation(); window.__animationSmoke.scene.updateMatrixWorld(true); window.ysmResetCamera();')
                baseline=frame.evaluate(MEASURE)
                assert_finite(baseline)
                # Model changes must create a fresh managed variable context.
                neutral=frame.evaluate('''() => {
                    window.ysmConfigureMolang(JSON.stringify(['ysm.head_yaw','query.anim_time','query.life_time']));
                    return JSON.parse(window.ysmEvaluateMolang(0.25,1.25,0.016));
                }''')
                assert neutral==[0,1.25,0.25], f'Stale/wrong managed context: {neutral}'
                for clip in ['climb','climbing','walk','run']:
                    samples=[]
                    for time in [0,0.25,0.5,0.75]:
                        frame.evaluate(SET_POSE,{'name':clip,'time':time})
                        measured=frame.evaluate(MEASURE)
                        assert_finite(measured)
                        assert measured['vertices']==baseline['vertices'], 'Visible model component disappeared'
                        frame.evaluate('window.ysmResetCamera()')
                        fitted=frame.evaluate(MEASURE)
                        assert_finite(fitted)
                        assert fitted['inFrame']==fitted['vertices'], 'Camera reset clips the model'
                        samples.append(measured['bones'])
                        records.append({'model':model,'clip':clip,'time':time,'vertices':measured['vertices'],
                            'finiteVertices':measured['finiteVertices'],'fittedInFrame':fitted['inFrame']})
                        if time==0.25 and clip in ['climb','climbing','run']:
                            frame.locator('#three-canvas').screenshot(path=str(output/(model+'-'+clip+'.png')))
                            if clip in ['climb','climbing']:
                                # These authored poses turn the body toward the
                                # camera. A second view distinguishes occlusion
                                # from missing geometry during visual review.
                                frame.evaluate('''async () => {
                                    const {THREE:T,scene,camera}=window.__animationSmoke;
                                    const bounds=new T.Box3();
                                    scene.traverseVisible(o=>{
                                        if(o.isMesh) bounds.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
                                    });
                                    const center=bounds.getCenter(new T.Vector3());
                                    const distance=camera.position.distanceTo(center);
                                    camera.position.copy(center).add(new T.Vector3(1,0.35,0.5).normalize().multiplyScalar(distance));
                                    camera.lookAt(center);
                                    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                                }''')
                                assert_finite(frame.evaluate(MEASURE))
                                frame.locator('#three-canvas').screenshot(path=str(output/(model+'-'+clip+'-side.png')))
                    if clip!='climbing':
                        assert any(sample!=samples[0] for sample in samples[1:]), f'{model}/{clip} remains frozen'
                    frame.evaluate('window.ysmStopAnimation()')
                    stopped=frame.evaluate(MEASURE); assert_finite(stopped)
                    assert_same_pose(stopped['bones'],baseline['bones'])
                    page.wait_for_timeout(50)
                    assert_same_pose(frame.evaluate(MEASURE)['bones'],stopped['bones'])
                    print(json.dumps({'model':model,'clip':clip,'samples':4,'finiteVertices':stopped['finiteVertices'],
                        'cameraReset':'PASS','stop':'PASS'}),flush=True)

                if model=='Itsuki':
                    # Full WASM->JS proof: original expression strings, nonzero
                    # context and changing time; no substitute evaluator or values.
                    frame.evaluate('''() => window.ysmLoadAnimationData(JSON.stringify({animations:{
                      __molang_regression:{animation_length:1,bones:{Root:{
                        rotation:[0,'5+ysm.head_yaw',0],
                        position:['query.anim_time*16','query.life_time*16',0]
                      }}}
                    }}))''')
                    frame.evaluate("window.ysmSetMolangVariable('ysm.head_yaw',25)")
                    for time in [0.25,1.25]:
                        frame.evaluate(SET_POSE,{'name':'__molang_regression','time':time})
                        measured=frame.evaluate(MEASURE); assert_finite(measured)
                        root=next(b for b in measured['bones'] if b['name']=='Root')
                        base_root=next(b for b in baseline['bones'] if b['name']=='Root')
                        assert abs(root['p'][0]-(base_root['p'][0]-time))<1e-5
                        assert abs(root['p'][1]-(base_root['p'][1]+time%1))<1e-5
                        expected=[0,-math.sin(math.pi/12),0,math.cos(math.pi/12)]
                        assert all(abs(x-y)<1e-5 for x,y in zip(root['q'],expected)), 'Managed arithmetic did not reach bone rotation'
                    frame.evaluate("window.ysmSetMolangVariable('ysm.head_yaw',-5)")
                    frame.evaluate('''async () => {await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}''')
                    changed=frame.evaluate(MEASURE)
                    root=next(b for b in changed['bones'] if b['name']=='Root')
                    assert all(abs(x-y)<1e-5 for x,y in zip(root['q'],[0,0,0,1])), 'Context changes require a reload'
                    frame.evaluate('window.ysmStopAnimation()')
                    print(json.dumps({'managedBridge':'PASS','nonzeroContext':'PASS','timeAndLoop':'PASS','liveContextChange':'PASS'}),flush=True)
            assert not errors, f'Browser errors: {errors}'
            assert not warnings, f'Animation fallback warnings: {warnings}'
            success=True
        finally:
            output.mkdir(parents=True,exist_ok=True)
            (output/'results.json').write_text(json.dumps({'success':success,'records':records,'errors':errors,'warnings':warnings},indent=2),encoding='utf-8')
            if not success:
                print(json.dumps({'success':False,'errors':errors,'warnings':warnings}),flush=True)
                page.screenshot(path=str(output/'failure.png'))
            browser.close()
    print(json.dumps({'success':True,'samples':len(records),'errors':errors,'warnings':warnings}),flush=True)


class Handler(SimpleHTTPRequestHandler):
    extensions_map={**SimpleHTTPRequestHandler.extensions_map,'.mjs':'text/javascript','.js':'text/javascript','.wasm':'application/wasm'}
    def log_message(self,*args): pass


def main():
    parser=argparse.ArgumentParser()
    location=parser.add_mutually_exclusive_group(required=True)
    location.add_argument('--dist',type=Path)
    location.add_argument('--url')
    parser.add_argument('--revision')
    parser.add_argument('--output',type=Path,default=Path('.vendor/animation-smoke'))
    parser.add_argument('--browser-channel')
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    server=None
    try:
        if args.dist:
            server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(args.dist.resolve())))
            threading.Thread(target=server.serve_forever,daemon=True).start()
            base=f'http://127.0.0.1:{server.server_port}/'
        else: base=args.url.rstrip('/')+'/'
        run(base,args.revision,args.output,args.browser_channel)
    finally:
        if server:
            server.shutdown(); server.server_close()


if __name__=='__main__': main()

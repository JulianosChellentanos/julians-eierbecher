// One source of truth: every displayed object can be loaded into the configurator.
export const STUDIO_DESIGNS = [
  { id:'twist', name:'Twist', description:'Flasche · gedrehte Rippen', color:'terrakotta', hex:'#c86f4a', config:{product:'vase',preset:'flasche',height:180,width:1,pattern:'rippen',ribs:64,depth:1.1,twist:0.6} },
  { id:'orbit', name:'Orbit', description:'Kugel · weiche Wellen', color:'salbei', hex:'#9caf88', config:{product:'vase',preset:'kugel',height:130,width:1.1,pattern:'wellen',ribs:36,depth:1.1,twist:0} },
  { id:'flow', name:'Flow', description:'Kurve · feine Lamellen', color:'elfenbein', hex:'#efe9dc', config:{product:'vase',preset:'kurve',height:180,width:1,pattern:'lamellen',ribs:64,depth:1.4,twist:0} },
  { id:'drop', name:'Drop', description:'Tropfen · spiralförmige Rippen', color:'staubblau', hex:'#7d9bb0', config:{product:'vase',preset:'tropfen',height:170,width:1,pattern:'rippen',ribs:56,depth:1,twist:-0.4} },
  { id:'column', name:'Column', description:'Zylinder · klare Facetten', color:'senf', hex:'#d4a940', config:{product:'vase',preset:'zylinder',height:170,width:0.85,pattern:'zickzack',ribs:40,depth:0.8,twist:0} },
  { id:'own', name:'Freiform', description:'Eigene Silhouette · dein Entwurf', color:'lavendel', hex:'#a58fb8', config:{product:'vase',preset:'eigene',height:180,width:1,pattern:'rippen',ribs:64,depth:0.9,twist:0,customPoints:[[0,.7],[.15,.88],[.3,.94],[.45,.72],[.6,.65],[.8,.8],[1,.78]]} },
];
export function designConfig(design) { return { ...design.config, color:design.color, text:'', saucer:false }; }

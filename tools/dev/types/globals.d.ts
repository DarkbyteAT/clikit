/**
 * Ambient globals for `tsc --checkJs` (tools/dev/typecheck.js). The page loads classic scripts that share
 * these globals; they are typed loosely on purpose: the type check is about each file's own JSDoc being
 * consistent with its code, not about typing the whole kit surface (see DECISIONS.md, "Types").
 */
declare var Kit: any;
declare const THREE: any;
declare const CANNON: any;
declare namespace THREE {
  type Object3D = any; type Vector3 = any; type Vector2 = any; type Color = any; type Material = any; type Mesh = any; type Group = any;
  type Camera = any; type OrthographicCamera = any; type PerspectiveCamera = any; type Scene = any; type Texture = any; type CanvasTexture = any;
  type BufferGeometry = any; type InstancedMesh = any; type Sprite = any; type Points = any; type DirectionalLight = any; type HemisphereLight = any;
  type WebGLRenderer = any; type Quaternion = any; type Euler = any; type Box3 = any; type Line = any; type Intersection = any; type Light = any;
}
/** Cannon types used in JSDoc, loose like THREE's: the physics library's own shapes are not what we check. */
declare namespace CANNON { type Body = any; type World = any; type Material = any; type Vec3 = any; }
interface Window { Kit: any; KIT_DEV?: boolean; KIT_LOCK_QUALITY?: boolean; [key: string]: any; }

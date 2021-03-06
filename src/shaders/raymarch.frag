#define MARCH_ITER 50
#define MARCH_NEAR 0.01
#define MARCH_MULT 0.9

#define PI 3.14159265
#define saturate(i) clamp(i,0.,1.)
#define lofi(i,m) (floor((i)/(m))*(m))
#define linearstep(a,b,x) saturate(((x)-(a))/((b)-(a)))

#extension GL_EXT_frag_depth : require
#extension GL_EXT_draw_buffers : require

precision highp float;

// == uniforms =====================================================================================
uniform float time;
uniform float beat;
uniform vec2 resolution;

uniform vec3 cameraPos;
uniform vec3 cameraTar;
uniform float perspFov;
uniform float perspNear;
uniform float perspFar;
uniform float cameraRoll;
uniform vec3 lightPos;

uniform float midi0;
uniform float midi1;
uniform float midi2;

uniform mat4 matPL;
uniform mat4 matVL;

uniform bool isPrePass;
uniform bool isShadow;

uniform sampler2D samplerPrePass;
uniform sampler2D samplerDepthMax;
uniform sampler2D samplerRandomStatic;
uniform sampler2D samplerShadow;

// == common functions =============================================================================
mat2 rotate2D( float _t ) {
  return mat2(
    cos( _t ), sin( _t ),
    -sin( _t ), cos( _t )
  );
}

float random( vec2 _uv ) {
  return fract( sin( dot( vec2( 12.563, 21.864 ), _uv ) ) * 194.5134 );
}

float smin( float a, float b, float k ) {
  float h = max( k - abs( a - b ), 0.0 ) / k;
  return min( a, b ) - h * h * h * k * ( 1.0 / 6.0 );
}

// == structs ======================================================================================
struct Camera {
  vec3 pos;
  vec3 dir;
  vec3 sid;
  vec3 top;
};

struct Ray {
  vec3 dir;
  vec3 ori;
};

// == struct methods ===============================================================================
Camera camInit( in vec3 _pos, in vec3 _tar, in float _roll ) {
  Camera cam;
  cam.pos = _pos;
  cam.dir = normalize( _tar - _pos );
  cam.sid = normalize( cross( cam.dir, vec3( 0.0, 1.0, 0.0 ) ) );
  cam.top = normalize( cross( cam.sid, cam.dir ) );
  cam.sid = cos( _roll ) * cam.sid + sin( _roll ) * cam.top;
  cam.top = normalize( cross( cam.sid, cam.dir ) );

  return cam;
}

Ray rayInit( in vec3 _ori, in vec3 _dir ) {
  Ray ray;
  ray.dir = _dir;
  ray.ori = _ori;
  return ray;
}

Ray rayFromCam( in vec2 _p, in Camera _cam, in float _fov ) {
  vec3 dir = normalize(
    _p.x * _cam.sid
    + _p.y * _cam.top
    + _cam.dir / tan( _fov * PI / 360.0 )
  );
  return rayInit( _cam.pos, dir );
}

// == distance functions ===========================================================================
float distFuncSphere( vec3 _p, float _r ) {
  return length( _p ) - _r;
}

float distFuncBox( vec3 _p, vec3 _s ) {
  vec3 d = abs( _p ) - _s;
  return min( max( d.x, max( d.y, d.z ) ), 0.0 ) + length( max( d, 0.0 ) );
}

vec3 circleRep( vec3 _p, float _r, float _c ) {
  vec3 p = _p;
  float intrv = PI * 2.0 / _c;
  p.zx = rotate2D( floor( atan( p.z, p.x ) / intrv ) * intrv ) * p.zx;
  p.zx = rotate2D( intrv / 2.0 ) * p.zx;
  p.x -= _r;
  return p;
}

vec3 ifs( vec3 _p, vec3 _rot, vec3 _shift ) {
  vec3 pos = _p;

  vec3 shift = _shift;

  for ( int i = 0; i < 5; i ++ ) {
    float intensity = pow( 2.0, -float( i ) );

    pos.y -= 0.0;

    pos = abs( pos ) - shift * intensity;

    shift.yz = rotate2D( _rot.x ) * shift.yz;
    shift.zx = rotate2D( _rot.y ) * shift.zx;
    shift.xy = rotate2D( _rot.z ) * shift.xy;

    if ( pos.x < pos.y ) { pos.xy = pos.yx; }
    if ( pos.x < pos.z ) { pos.xz = pos.zx; }
    if ( pos.y < pos.z ) { pos.yz = pos.zy; }
  }

  return pos;
}

float distFunc( vec3 _p ) {
  float dist = 1E9;

  vec3 p = mod( _p - vec3( 0.0, time, 0.0 ) + 5.0, 10.0 ) - 5.0;
  vec3 pIfs = ifs( p, vec3( 0.09, -0.03, 0.18 ), 10.0 * vec3( midi0, midi1, midi2 ) );

  {
    dist = max(
      -distFuncBox( p, vec3( 2.5, 100.0, 5.5 ) ),
      distFuncBox( pIfs, vec3( 0.1 + 0.4 * sin( PI * exp( -fract( beat ) ) ) ) )
    );
  }

  return dist;
}

vec3 normalFunc( in vec3 _p, in float _d ) {
  vec2 d = vec2( 0.0, 1.0 ) * _d;
  vec3 nor = normalize( vec3(
    distFunc( _p + d.yxx ) - distFunc( _p - d.yxx ),
    distFunc( _p + d.xyx ) - distFunc( _p - d.xyx ),
    distFunc( _p + d.xxy ) - distFunc( _p - d.xxy )
  ) );
  return nor;
}

vec3 normalFunc( in vec3 _p ) {
  return normalFunc( _p, 1E-4 );
}

// == main procedure ===============================================================================
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec2 p = ( gl_FragCoord.xy * 2.0 - resolution ) / resolution.y;

  vec4 texPrePass;
  if ( !isPrePass ) {
    texPrePass = texture2D( samplerPrePass, uv );
    if ( texPrePass.y == 0.0 ) { discard; }
  }

  Camera cam = camInit( cameraPos, cameraTar, cameraRoll );
  if ( isShadow ) { cam = camInit( lightPos, cameraTar, 0.0 ); }
  Ray ray = rayFromCam( p, cam, perspFov );

  float rayLen = isPrePass ? perspNear : MARCH_MULT * texPrePass.x;
  vec3 rayPos = ray.ori + rayLen * ray.dir;
  float dist = 0.0;
  float depthMax = texture2D( samplerDepthMax, uv ).x;
  bool isValid = true;

  for ( int i = 0; i < MARCH_ITER; i ++ ) {
    dist = distFunc( rayPos );
    rayLen += dist * MARCH_MULT;
    rayPos = ray.ori + rayLen * ray.dir;

    if ( depthMax < rayLen ) { isValid = false; break; }
    if ( perspFar < rayLen ) { isValid = false; break; }
    if ( abs( dist ) < MARCH_NEAR * ( isPrePass ? 4.0 : 1.0 ) ) { break; }
  }

  if ( isPrePass ) {
    gl_FragData[ 0 ] = vec4( rayLen, isValid ? 1.0 : 0.0, 0.0, 1.0 );
    return;
  }

  if ( MARCH_NEAR < abs( dist ) ) { discard; }

  if ( isShadow ) {
    gl_FragData[ 0 ] = vec4( rayPos, 1.0 );

    {
      float a = ( perspFar + perspNear ) / ( perspFar - perspNear );
      float b = 2.0 * perspFar * perspNear / ( perspFar - perspNear );
      float z = dot( cam.dir, rayPos - lightPos );
      gl_FragDepthEXT = ( a - b / z ) * 0.5 + 0.5;
    }
    return;
  }

  vec3 nor = normalFunc( rayPos, 1E-4 );
  float edge = smoothstep( 0.1, 0.2, length( nor - normalFunc( rayPos, 1E-2 ) ) );
  vec3 col = vec3( 0.07, 0.10, 0.11 ) + edge * 0.0 * vec3( 2.4, 0.1, 0.3 );

  gl_FragData[ 0 ] = vec4( col, 2.0 );
  gl_FragData[ 1 ] = vec4( rayPos, 1.0 );
  gl_FragData[ 2 ] = vec4( nor, 1.0 );

  {
    float a = ( perspFar + perspNear ) / ( perspFar - perspNear );
    float b = 2.0 * perspFar * perspNear / ( perspFar - perspNear );
    float z = dot( cam.dir, rayPos - cam.pos );
    gl_FragDepthEXT = ( a - b / z ) * 0.5 + 0.5;
  }
}

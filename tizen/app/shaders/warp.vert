#version 300 es
precision highp float;

// Full-screen triangle-strip quad covering NDC [-1, 1]^2
const vec2 POSITIONS[4] = vec2[4](
    vec2(-1.0, -1.0),
    vec2( 1.0, -1.0),
    vec2(-1.0,  1.0),
    vec2( 1.0,  1.0)
);

const vec2 TEXCOORDS[4] = vec2[4](
    vec2(0.0, 0.0),
    vec2(1.0, 0.0),
    vec2(0.0, 1.0),
    vec2(1.0, 1.0)
);

out vec2 vUv;

void main() {
    gl_Position = vec4(POSITIONS[gl_VertexID], 0.0, 1.0);
    vUv = TEXCOORDS[gl_VertexID];
}

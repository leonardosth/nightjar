# Nightjar for Samsung Tizen OS 10 TV (with Frame Warp)

[Nightjar docs](index.md) · [Frame Warp Protocol](protocol/frame-warp.md)

This fork adapts **Nightjar** (the host-neutral Moonlight-protocol client paired with **Rubylight**) to run natively on **Samsung Smart TVs running Tizen OS 10** (Chromium M130), with first-class support for **Frame Warp v1**.

---

## Como funciona o Frame Warp na TV Samsung (Tizen OS 10)

O **Frame Warp** reduz drasticamente a latência percebida de câmera (mouse ou analógico direito do controle) deslocando o quadro de vídeo na GPU da TV a cada atualização da tela (60/120/144 Hz), enquanto mantém o HUD do jogo (mira, barra de vida, minimapa) 100% fixo usando a máscara enviada pelo Rubylight.

Para fazer isso no Tizen OS 10 sem copiar quadros de volta para a CPU, esta arquitetura combina:

1. **Tizen Sockets Extension (`tizen/wasm/`)**: permite conexões diretas TCP/UDP (HTTP/mTLS, RTSP `a=x-rl-control`, ENet criptografado `SS_ENC_CONTROL_V2` e RTP vídeo/áudio) direto da TV para o PC com Rubylight, sem servidor proxy.
2. **Tizen WASM Player em modo `RenderingMode::kVideoTexture`**:
   ```cpp
   samsung::wasm::ElementaryMediaStreamSource(
       LatencyMode::kUltraLow,
       RenderingMode::kVideoTexture
   );
   ```
   O decodificador de vídeo por hardware da TV (HEVC / AV1 / H.264) escreve cada frame diretamente em uma textura WebGL 2.0 / GLES 3.0 (`FillTextureWithNextFrameSync`).
3. **Shader WebGL 2.0 / GLES 3.00 es (`tizen/app/shaders/warp.frag` & `tizen/wasm/src/warp_gl_renderer.cpp`)**:
   - Porta fielmente o shader do Nightjar (`app/src/main/assets/shaders/warp.frag` e `protocol/desktop-media/src/frame_warp.hlsl`).
   - Aplica a projeção de **lente em perspectiva** (`Model::focal`) para que as bordas da imagem girem corretamente em FOVs amplos.
   - Faz **verificação dupla da máscara de HUD (`GL_R8`)** tanto na posição de destino quanto na posição de origem deslocada, evitando deslocamento e "fantasma" (duplicação) do HUD.
   - Preenche as bordas reveladas com **espelhamento + escurecimento progressivo de 35% nos primeiros 8%**.
   - Faz **redesenho inter-frame** a cada `requestAnimationFrame` (120 Hz / 144 Hz) sempre que o movimento de câmera mudar `>= 0.25 px` entre quadros recebidos.
4. **Protocolo Frame Warp v1 completo (`0x5543..0x5546`)**:
   - `tizen/wasm/src/frame_warp_protocol.{hpp,cpp}` + `frame_warp_predictor.{hpp,cpp}` (C++17)
   - `tizen/app/js/frame-warp.js` (ES Module idêntico, testado via Node.js e usado no **Frame Warp Lab** interativo)

---

## Estrutura do Port (`tizen/`)

```text
tizen/
├── app/                      # Pacote Tizen Web App (.wgt)
│   ├── config.xml            # Manifesto tv-samsung (privilégios internet, tv.inputdevice)
│   ├── index.html            # Interface TV 10-foot (controle remoto + gamepad)
│   ├── css/nightjar-tv.css   # Tema escuro glassmorphic inspirado no Nightjar
│   ├── shaders/
│   │   ├── warp.vert         # Vertex shader WebGL 2.0 / GLES 3.00 es
│   │   └── warp.frag         # Fragment shader Frame Warp v1 (lente + HUD mask + edge fill)
│   └── js/
│       ├── frame-warp.js     # Codecs 0x5543..0x5546 + Predictor + FrameRing
│       ├── warp-renderer.js  # Renderer WebGL 2.0 + inter-frame redraws
│       ├── input-manager.js  # Controle remoto Tizen + Gamepad API + Mouse Pointer Lock
│       ├── wasm-bridge.js    # Ponte WASM + Simulador Rubylight (Frame Warp Lab)
│       └── app.js            # Controlador da aplicação TV
├── wasm/                     # Motor C++17 (Samsung Emscripten SDK)
│   ├── CMakeLists.txt
│   ├── src/
│   │   ├── frame_warp_protocol.{hpp,cpp}
│   │   ├── frame_warp_predictor.{hpp,cpp}
│   │   ├── tizen_video_decoder.{hpp,cpp}
│   │   ├── warp_gl_renderer.{hpp,cpp}
│   │   ├── nightjar_session.{hpp,cpp}
│   │   └── main.cpp
│   └── tests/frame_warp_test.cpp
├── tests/frame-warp.test.mjs # Testes unitários completos (node --test)
├── Dockerfile                # Build reprodutível do .wasm com Samsung Emscripten SDK
└── build-wgt.ps1             # Empacotamento, assinatura (.wgt) e deploy via sdb
```

---

## Como compilar e instalar na sua TV Samsung (Tizen OS 10)

### 1. Empacotar e assinar o `.wgt` (Windows com Tizen Studio CLI)

```powershell
# Compila o pacote assinado em tizen/dist/Nightjar.wgt e roda todos os testes do Frame Warp:
.\tizen\build-wgt.ps1 -Profile leonardosth2
```

### 2. (Para streaming direto via Tizen Sockets + Hardware Decoder) Compilar o `.wasm`

O módulo C++ em `tizen/wasm/` usa o **Samsung Emscripten SDK** (`Tizen WASM Player` + `Tizen Sockets Extension`). Com Docker instalado (ou via GitHub Actions em `.github/workflows/tizen.yml`):

```powershell
mkdir tizen\app\wasm -Force
docker build -f tizen/Dockerfile -t nightjar-tizen-wasm .
docker run --rm -v "${PWD}\tizen\app\wasm:/out" nightjar-tizen-wasm
# Em seguida, gere o .wgt novamente para incluir tizen/app/wasm/:
.\tizen\build-wgt.ps1 -Profile leonardosth2
```

### 3. Instalar na TV Samsung via Modo Desenvolvedor (`sdb`)

1. Na TV Samsung, abra **Apps** e digite **`12345`** no controle remoto.
2. Ative o **Developer Mode**, informe o IP do seu PC e reinicie a TV.
3. Conecte e instale direto pelo script:
   ```powershell
   .\tizen\build-wgt.ps1 -Profile leonardosth2 -TvIp <IP_DA_SUA_TV>
   ```
   Ou manualmente:
   ```powershell
   sdb connect <IP_DA_SUA_TV>:26101
   tizen install -n Nightjar.wgt -t <IP_DA_SUA_TV>:26101 -- tizen\dist
   ```

### 4. Testando o Frame Warp na TV ou no PC

- **Frame Warp Lab (embutido no app):** clique em **Launch Frame Warp Live Test** na tela inicial. Ele simula um host Rubylight com 45 ms de latência emitindo pacotes binários reais `0x5544` (Model com lente FOV 90°), `0x5545` (Tags) e `0x5546` (HUD Mask RLE), permitindo mover o analógico direito do controle ou o mouse e verificar visualmente a compensação instantânea com o HUD travado.
- **Com Rubylight real:** no PC com Rubylight, certifique-se de que o Frame Warp está habilitado (o host anuncia `<FrameWarpVersion>1</FrameWarpVersion>` em `/serverinfo` e `0x5543..0x5546` em `a=x-rl-control`). No app Nightjar da TV, mantenha **Settings → Frame Warp → Enable Frame Warp** e **Perspective Lens Warping** ativados.

/**
 * Nightjar Tizen TV localization (en, pt-BR) and settings migration.
 * Follows AGENTS.md: host-neutral Nightjar wording, retired keys cleared,
 * and every setting help text states what the player gets, costs, and when to change it in 2 short sentences.
 */

export const RETIRED_SETTING_KEYS = Object.freeze(['fwLens', 'fwMaskWidth']);

export const DEFAULT_SETTINGS = Object.freeze({
  resolution: '3840x2160',
  fps: '60',
  codec: 'hevc',
  bitrate: '100',
  hdr: false,
  surround51: false,
  fwEnabled: true,
  overlay: false,
});

export function migrateSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  for (const retired of RETIRED_SETTING_KEYS) {
    delete merged[retired];
  }
  if (!['1920x1080', '2560x1440', '3840x2160'].includes(String(merged.resolution))) {
    merged.resolution = DEFAULT_SETTINGS.resolution;
  }
  if (!['60', '120'].includes(String(merged.fps))) {
    merged.fps = DEFAULT_SETTINGS.fps;
  }
  if (!['hevc', 'av1', 'h264'].includes(String(merged.codec))) {
    merged.codec = DEFAULT_SETTINGS.codec;
  }
  if (!['30', '60', '100', '120', '150'].includes(String(merged.bitrate))) {
    merged.bitrate = DEFAULT_SETTINGS.bitrate;
  }
  merged.hdr = Boolean(merged.hdr);
  merged.surround51 = Boolean(merged.surround51);
  merged.fwEnabled = Boolean(merged.fwEnabled);
  merged.overlay = Boolean(merged.overlay);
  return merged;
}

export const STRINGS = Object.freeze({
  en: Object.freeze({
    'app.title': 'Nightjar',
    'app.subtitle': 'TV Streaming Client',
    'tab.hosts': 'PCs',
    'tab.settings': 'Settings',
    'tab.lab': 'Frame Warp Lab',
    'pill.wasmChecking': 'Engine: Checking…',
    'pill.wasmReady': 'Engine: Ready',
    'pill.wasmMissing': 'Engine: Not built',
    'pill.padNone': 'Gamepad: None',
    'pill.padCount': 'Gamepad: {count} connected',
    'hero.title': 'Low-latency PC streaming for your TV',
    'hero.body': 'Hardware-decoded 4K video with optional Frame Warp camera prediction on supported hosts.',
    'btn.addPc': '+ Add PC',
    'btn.openLab': 'Open Frame Warp Lab',
    'btn.removePc': 'Remove',
    'btn.cancel': 'Cancel',
    'btn.save': 'Save PC',
    'btn.ok': 'OK',
    'btn.resumeGame': 'Resume Running App',
    'btn.quitGame': 'Quit Running App',
    'btn.close': 'Close',
    'hosts.heading': 'Saved PCs',
    'hosts.hint': 'Use TV Remote or Gamepad to select, Red key to remove',
    'hosts.empty': 'No PCs saved yet. Select "+ Add PC" to enter your PC IP address.',
    'hosts.paired': 'Paired',
    'hosts.unpaired': 'Not paired',
    'hosts.fwSupported': 'Frame Warp v{ver}',
    'hosts.standard': 'Standard stream',
    'settings.videoHeading': 'Video & Audio',
    'settings.fwHeading': 'Frame Warp & Diagnostics',
    'setting.resolution': 'Resolution',
    'setting.fps': 'Frame Rate',
    'setting.codec': 'Video Codec',
    'setting.bitrate': 'Bitrate',
    'setting.hdr': 'HDR10 (10-bit)',
    'setting.surround51': '5.1 Surround Audio',
    'setting.fwEnabled': 'Frame Warp',
    'setting.overlay': 'Performance Overlay',
    'help.resolution': 'Streams sharper detail up to 4K at the cost of higher network and decoder load. Lower it to 1440p or 1080p if your TV drops frames.',
    'help.fps': 'Doubles motion smoothness at 120 fps while requiring twice the encode and decode speed. Use 60 fps if 120 fps stutters or exceeds your PC framerate.',
    'help.codec': 'HEVC and AV1 deliver cleaner 4K video than H264 at high bitrates. Switch to H264 only if your PC or TV hardware decoder rejects HEVC.',
    'help.bitrate': 'Higher bitrates keep fast 4K scenes crisp but demand a stable wired or 6 GHz network. Lower it if you see packet loss or freezes.',
    'help.hdr': 'Enables 10-bit HDR10 color on supported games using direct hardware video output. Turn it off if you want Frame Warp active or colors look washed out.',
    'help.surround51': 'Sends six discrete audio channels to an AVR or soundbar with slightly higher audio bitrate. Keep it off for stereo TV speakers.',
    'help.fwEnabled': 'Shows camera turns on the next TV refresh while keeping HUD elements fixed when the host supports it. Turn it off for direct hardware scanout or HDR10.',
    'help.overlay': 'Displays live received, decoded, rendered FPS and Frame Warp shift metrics on screen. Turn it on while tuning settings and off during normal play.',
    'modal.addTitle': 'Add PC',
    'modal.addDesc': 'Enter your PC local IP address or hostname.',
    'modal.pcName': 'PC Name',
    'modal.pcIp': 'IP Address / Hostname',
    'modal.appsTitle': 'Apps on {host}',
    'modal.appsEmpty': 'No apps returned by the host.',
    'modal.pairTitle': 'Pair with {host}',
    'modal.pairBody': 'Enter PIN {pin} on your PC now. Waiting for confirmation…',
    'dialog.connFailed': 'Connection Failed',
    'dialog.pairFailed': 'Pairing Failed',
    'dialog.streamError': 'Stream Error',
    'dialog.streamEnded': 'Stream Ended',
    'dialog.engineMissingTitle': 'Native Engine Missing',
    'dialog.engineMissingBody': 'Build the WASM streaming binary in tizen/wasm/ to connect to a real PC, or open Frame Warp Lab for offline testing.',
    'menu.title': 'Stream Menu',
    'menu.fwOn': 'Frame Warp: ON',
    'menu.fwOff': 'Frame Warp: OFF',
    'menu.ovOn': 'Overlay: ON',
    'menu.ovOff': 'Overlay: OFF',
    'menu.resume': 'Resume Stream',
    'menu.disconnect': 'Disconnect',
    'footer.nav': 'Navigate',
    'footer.select': 'Select',
    'footer.back': 'Return',
    'footer.menu': 'Stream Menu',
  }),
  'pt-BR': Object.freeze({
    'app.title': 'Nightjar',
    'app.subtitle': 'Cliente de Streaming para TV',
    'tab.hosts': 'PCs',
    'tab.settings': 'Configurações',
    'tab.lab': 'Laboratório Frame Warp',
    'pill.wasmChecking': 'Motor: Verificando…',
    'pill.wasmReady': 'Motor: Pronto',
    'pill.wasmMissing': 'Motor: Não compilado',
    'pill.padNone': 'Controle: Nenhum',
    'pill.padCount': 'Controle: {count} conectado(s)',
    'hero.title': 'Streaming de PC com baixa latência na sua TV',
    'hero.body': 'Vídeo 4K decodificado em hardware com predição de câmera Frame Warp opcional nos hosts compatíveis.',
    'btn.addPc': '+ Adicionar PC',
    'btn.openLab': 'Abrir Laboratório Frame Warp',
    'btn.removePc': 'Remover',
    'btn.cancel': 'Cancelar',
    'btn.save': 'Salvar PC',
    'btn.ok': 'OK',
    'btn.resumeGame': 'Retomar App em Execução',
    'btn.quitGame': 'Encerrar App no PC',
    'btn.close': 'Fechar',
    'hosts.heading': 'PCs Salvos',
    'hosts.hint': 'Use o controle remoto ou gamepad para selecionar, tecla Vermelha para remover',
    'hosts.empty': 'Nenhum PC salvo ainda. Selecione "+ Adicionar PC" para informar o IP do seu PC.',
    'hosts.paired': 'Pareado',
    'hosts.unpaired': 'Não pareado',
    'hosts.fwSupported': 'Frame Warp v{ver}',
    'hosts.standard': 'Stream padrão',
    'settings.videoHeading': 'Vídeo e Áudio',
    'settings.fwHeading': 'Frame Warp e Diagnóstico',
    'setting.resolution': 'Resolução',
    'setting.fps': 'Taxa de Quadros',
    'setting.codec': 'Codec de Vídeo',
    'setting.bitrate': 'Bitrate',
    'setting.hdr': 'HDR10 (10 bits)',
    'setting.surround51': 'Áudio Surround 5.1',
    'setting.fwEnabled': 'Frame Warp',
    'setting.overlay': 'Painel de Desempenho',
    'help.resolution': 'Entrega imagem mais nítida até 4K ao custo de maior carga na rede e no decodificador. Reduza para 1440p ou 1080p se a TV perder quadros.',
    'help.fps': 'Dobra a fluidez em 120 fps exigindo o dobro de velocidade de codificação e decodificação. Use 60 fps se 120 fps engasgar ou superar o FPS do jogo.',
    'help.codec': 'HEVC e AV1 mantêm 4K mais limpo que H264 em bitrates altos. Troque para H264 apenas se o decodificador do PC ou da TV recusar HEVC.',
    'help.bitrate': 'Bitrates altos preservam detalhes em cenas rápidas 4K, mas exigem rede cabeada ou Wi-Fi 6 GHz estável. Diminua se houver perda de pacotes ou travamentos.',
    'help.hdr': 'Ativa cores HDR10 de 10 bits em jogos compatíveis usando saída direta de hardware. Desative se quiser usar Frame Warp ou se as cores ficarem lavadas.',
    'help.surround51': 'Envia seis canais separados para soundbar ou receiver com leve aumento no tráfego de áudio. Mantenha desligado nos alto-falantes estéreo da TV.',
    'help.fwEnabled': 'Mostra giros de câmera na atualização seguinte da TV mantendo o HUD fixo quando o host oferece suporte. Desative para usar saída direta de hardware ou HDR10.',
    'help.overlay': 'Exibe na tela FPS recebido, decodificado, renderizado e deslocamento do Frame Warp. Ative ao ajustar as configurações e desative durante o jogo normal.',
    'modal.addTitle': 'Adicionar PC',
    'modal.addDesc': 'Informe o endereço IP local ou hostname do seu PC.',
    'modal.pcName': 'Nome do PC',
    'modal.pcIp': 'Endereço IP / Hostname',
    'modal.appsTitle': 'Apps em {host}',
    'modal.appsEmpty': 'Nenhum aplicativo retornado pelo PC.',
    'modal.pairTitle': 'Parear com {host}',
    'modal.pairBody': 'Digite o PIN {pin} no seu PC agora. Aguardando confirmação…',
    'dialog.connFailed': 'Falha na Conexão',
    'dialog.pairFailed': 'Falha no Pareamento',
    'dialog.streamError': 'Erro no Stream',
    'dialog.streamEnded': 'Stream Encerrado',
    'dialog.engineMissingTitle': 'Motor Nativo Ausente',
    'dialog.engineMissingBody': 'Compile o módulo WASM em tizen/wasm/ para conectar a um PC real, ou abra o Laboratório Frame Warp para teste offline.',
    'menu.title': 'Menu do Stream',
    'menu.fwOn': 'Frame Warp: LIGADO',
    'menu.fwOff': 'Frame Warp: DESLIGADO',
    'menu.ovOn': 'Painel: LIGADO',
    'menu.ovOff': 'Painel: DESLIGADO',
    'menu.resume': 'Voltar ao Stream',
    'menu.disconnect': 'Desconectar',
    'footer.nav': 'Navegar',
    'footer.select': 'Selecionar',
    'footer.back': 'Voltar',
    'footer.menu': 'Menu do Stream',
  }),
});

export function resolveLocale(navLang) {
  if (typeof navLang === 'string' && navLang.toLowerCase().startsWith('pt')) {
    return 'pt-BR';
  }
  return 'en';
}

export function tr(locale, key, vars = {}) {
  const table = STRINGS[locale] || STRINGS.en;
  let text = table[key] ?? STRINGS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

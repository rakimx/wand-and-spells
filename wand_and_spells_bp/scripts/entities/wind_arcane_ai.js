import { world, system } from "@minecraft/server";
import { getSpellProps } from "../utils/common.js";
import { executeSpell } from "../spells/spell_caster.js";

/**
 * O Arcano do Raio.
 *
 * Ele nao bate em ninguem. Mantem uma distancia de trabalho e lanca as magias
 * do proprio addon - as mesmas que o jogador pode aprender, com os mesmos
 * numeros, pelo mesmo executeSpell. Nada de ataques inventados so para ele.
 *
 * Nem todas as magias servem a um mob. O executeSpell so toca em
 * player.onScreenDisplay no ramo dos pergaminhos, e getHeadLocation e
 * getViewDirection existem em qualquer entidade, por isso o caminho geral
 * passa. Mas ha magias que por dentro chamam player.playSound, que nao existe
 * num mob, e ha as canalizadas, que precisam do botao preso. Do elemento raio
 * ficam de fora, por isso, o Arco e o Raio Laser (canalizadas) e a Corrente de
 * Relampagos, o Raio de Relampago e o Espectro (player.playSound). As cinco
 * que ele usa foram todas verificadas uma a uma.
 */

/** A que familia ele responde */
const FAMILIA = "ws_wind_arcane";

/** De quantos em quantos ticks o cerebro dele corre */
const PENSAR = 10;

/** Ate onde ele repara num jogador */
const ALCANCE = 32;

/**
 * A faixa em que ele gosta de lutar. Mais perto e ele sai dali; mais longe e
 * aproxima-se. No meio, fica a rodar a volta do jogador.
 */
const PERTO_DEMAIS = 6;
const LONGE_DEMAIS = 22;

/** A saida defensiva - movimento, nao magia */
const SALTO_DISTANCIA = 8;
const SALTO_RECARGA = 90;

/** Com que forca ele desliza de lado enquanto lanca */
const RODEIO = 0.22;

/** Abaixo desta fatia da vida ele muda de andamento */
const LIMIAR_FURIA = 0.5;

/** Quanto as recargas encurtam quando ele fica furioso */
const PRESSA_FURIA = 0.62;

/**
 * Quanto tempo a propriedade ws:casting fica ligada.
 *
 * A animacao do golpe dura 0,3333 s, ou seja 6,7 ticks. Este numero so precisa
 * de lhe dar folga para correr inteira antes de o estado voltar ao repouso. Se
 * mexeres na duracao da animacao, mexe aqui.
 */
const POSE_TICKS = 9;

/**
 * O repertorio: so magias que existem no addon.
 *
 * As recargas nao sao as do jogador. O magic_missile recarrega em 5 ticks numa
 * varinha, o que num boss seriam quatro misseis por segundo; aqui ele tem um
 * compasso proprio. O alcance e o dano, esses, vem das definicoes das magias,
 * por isso reequilibrar uma magia reequilibra tambem o boss.
 *
 * `minimo` e a distancia abaixo da qual ele nao lanca. O martelo e o simbolo
 * nascem onde a mira bate, e com o jogador colado a ele isso cairia em cima
 * dele proprio.
 *
 * `modificadores` sao os mesmos que uma varinha aplicaria, e so tocam na copia
 * dele: as magias que o jogador aprende ficam exactamente como estao.
 */
const REPERTORIO = [
    {
        // O martelo e o especial dele. A magia do jogador dura 600 ticks e fica
        // a descarregar de 40 em 40; num boss isso era uma torre de relampagos
        // plantada no campo durante meio minuto, por isso duration 0.25 corta
        // para 7,5 s. blast encolhe o raio de accao de 10 para 7.
        id: "ws:lightning_hammer", recarga: 560, minimo: 6, soFurioso: false,
        modificadores: { range: 1, duration: 0.25, blast: 0.7 }
    },
    {
        // O simbolo fica no chao a espera. Serve para ele negar o sitio onde tu
        // estas, e obriga a sair de la.
        id: "ws:lightning_sigil", recarga: 240, minimo: 4, soFurioso: false,
        modificadores: { range: 1, duration: 1, blast: 1 }
    },
    {
        // Estouro em volta: e o que ele usa quando o deixam encostar
        id: "ws:lightning_pulse", recarga: 110, minimo: 0, soFurioso: false,
        modificadores: { range: 1, duration: 1, blast: 1 }
    },
    {
        // O ataque normal, de longe. Barato e frequente, como deve ser.
        id: "ws:thunderbolt", recarga: 40, minimo: 0, soFurioso: false,
        modificadores: { range: 1, duration: 1, blast: 1 }
    }
];

/**
 * A magia com que ele se tira da frente quando o encurralam.
 *
 * A Investida atira quem a lanca para onde esta a olhar, por isso serve de
 * fuga: basta virar-lhe as costas antes. E de raio, como o resto dele.
 */
const FUGA = "ws:charge";

/** Quando dura o alcance de cada magia, tirado da sua propria definicao */
function alcanceDe(spellId) {
    const props = getSpellProps(spellId);
    return props.range ?? 16;
}

/** O que cada boss tem em memoria */
const memoria = new Map();

function lembranca(boss) {
    let m = memoria.get(boss.id);
    if (!m) {
        m = { recargas: {}, alvoId: null, furioso: false, ultimoSalto: -9999, lado: 1 };
        memoria.set(boss.id, m);
    }
    return m;
}

function centro(entidade) {
    const l = entidade.location;
    return { x: l.x, y: l.y + 1.0, z: l.z };
}

function poeira(dimension, onde, particula, quantas = 6, raio = 0.6) {
    for (let i = 0; i < quantas; i++) {
        try {
            dimension.spawnParticle(particula, {
                x: onde.x + (Math.random() - 0.5) * raio * 2,
                y: onde.y + (Math.random() - 0.5) * raio,
                z: onde.z + (Math.random() - 0.5) * raio * 2
            });
        } catch { }
    }
}

/**
 * Um jogador conta como adversario?
 *
 * Quem esta em criativo ou de espectador nao conta. Isto nao e um pormenor: o
 * boss andava a atacar quem estava so a construir.
 */
function eAdversario(jogador) {
    try {
        if (!jogador.isValid()) return false;
        const modo = jogador.getGameMode();
        if (modo === "creative" || modo === "spectator") return false;
        const vida = jogador.getComponent("minecraft:health");
        if (vida && vida.currentValue <= 0) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Consegue ver dali para ali? Amostra a linha de um metro em metro - chega para
 * ele deixar de lancar atraves de paredes.
 */
function temVista(dimension, de, para) {
    const dx = para.x - de.x, dy = para.y - de.y, dz = para.z - de.z;
    const passos = Math.min(28, Math.max(2, Math.round(Math.hypot(dx, dy, dz))));
    for (let i = 1; i < passos; i++) {
        const t = i / passos;
        try {
            const bloco = dimension.getBlock({
                x: Math.floor(de.x + dx * t),
                y: Math.floor(de.y + dy * t),
                z: Math.floor(de.z + dz * t)
            });
            if (!bloco) return false;
            if (bloco.typeId !== "minecraft:air" && !bloco.typeId.includes("water")) return false;
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * Quem ele vai atacar. Mantem o mesmo enquanto servir, para nao andar a saltar
 * de alvo a cada dez ticks.
 */
function escolherAlvo(boss, mem) {
    if (mem.alvoId) {
        for (const j of world.getAllPlayers()) {
            if (j.id !== mem.alvoId) continue;
            if (!eAdversario(j) || j.dimension.id !== boss.dimension.id) break;
            const d = Math.hypot(j.location.x - boss.location.x, j.location.y - boss.location.y, j.location.z - boss.location.z);
            if (d <= ALCANCE + 6) return j;
            break;
        }
        mem.alvoId = null;
    }

    let perto = null;
    let melhor = ALCANCE * ALCANCE;
    for (const j of world.getAllPlayers()) {
        if (!eAdversario(j)) continue;
        try {
            if (j.dimension.id !== boss.dimension.id) continue;
            const dx = j.location.x - boss.location.x;
            const dy = j.location.y - boss.location.y;
            const dz = j.location.z - boss.location.z;
            const d = dx * dx + dy * dy + dz * dz;
            if (d < melhor) { melhor = d; perto = j; }
        } catch { }
    }
    if (perto) mem.alvoId = perto.id;
    return perto;
}

/** Levanta o cajado, e volta a baixa-lo quando o golpe acaba */
function mostrarLancamento(boss) {
    try { boss.setProperty("ws:casting", true); } catch { }
    system.runTimeout(() => {
        try { if (boss.isValid()) boss.setProperty("ws:casting", false); } catch { }
    }, POSE_TICKS);
}

/**
 * Aponta o boss ao alvo, de corpo inteiro.
 *
 * O martelo e o simbolo escolhem onde nascer com um findAimTarget que segue a
 * direccao do olhar, e essa vem da rotacao da entidade. Sem acertar tambem a
 * inclinacao, ele lancava-os sempre ao nivel do horizonte.
 */
function apontar(boss, alvo) {
    try {
        const de = boss.getHeadLocation();
        const para = centro(alvo);
        const dx = para.x - de.x, dy = para.y - de.y, dz = para.z - de.z;
        const plano = Math.hypot(dx, dz);
        boss.setRotation({
            x: -Math.atan2(dy, plano) * 180 / Math.PI,
            y: -Math.atan2(dx, dz) * 180 / Math.PI
        });
    } catch { }
}

// ----------------------------------------------------------- a movimentacao

/**
 * Quando o deixam encostado, ele lanca a Investida para tras.
 *
 * A Investida atira quem a lanca para onde esta a olhar, por isso ele tem de se
 * virar de costas ao jogador antes de a lancar. Logo a seguir o pensar() volta
 * a apontar-lhe, por isso a viragem nao chega a ver-se.
 */
function saltarParaTras(boss, alvo) {
    try {
        const dx = boss.location.x - alvo.location.x;
        const dz = boss.location.z - alvo.location.z;
        const r = boss.getRotation();
        boss.setRotation({ x: 0, y: -Math.atan2(dx, dz) * 180 / Math.PI });
        const saiu = executeSpell(boss, FUGA, false) !== false;
        if (!saiu) { boss.setRotation(r); }
        return saiu;
    } catch (err) {
        console.warn("[Arcano do Raio] a fuga falhou: " + err);
        return false;
    }
}

/** Desliza de lado a volta do alvo, para nao ficar parado como um poste */
function rodear(boss, alvo, mem) {
    const dx = alvo.location.x - boss.location.x;
    const dz = alvo.location.z - boss.location.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    try {
        boss.applyKnockback(-(dz / dist) * mem.lado, (dx / dist) * mem.lado, RODEIO, 0);
    } catch { }
}

// ------------------------------------------------------------------ a mente

/** Metade da vida: ele acelera */
function verFuria(boss, mem) {
    if (mem.furioso) return;
    try {
        const vida = boss.getComponent("minecraft:health");
        if (!vida || vida.currentValue > vida.effectiveMax * LIMIAR_FURIA) return;
    } catch { return; }

    mem.furioso = true;
    const dimension = boss.dimension;
    poeira(dimension, centro(boss), "ws:lightning_sparkle", 40, 2.5);
    try { dimension.playSound("spell.lightning_pulse", boss.location, { pitch: 1.3 }); } catch { }
    for (const j of world.getAllPlayers()) {
        try {
            if (j.dimension.id !== dimension.id) continue;
            const d = Math.hypot(j.location.x - boss.location.x, j.location.y - boss.location.y, j.location.z - boss.location.z);
            if (d > 40) continue;
            j.onScreenDisplay.setActionBar({ translate: "ws.msg.wind_arcane_enraged" });
        } catch { }
    }
}

function pensar(boss) {
    const mem = lembranca(boss);
    const alvo = escolherAlvo(boss, mem);
    if (!alvo) {
        try { boss.setProperty("ws:casting", false); } catch { }
        return;
    }

    verFuria(boss, mem);

    const dist = Math.hypot(
        alvo.location.x - boss.location.x,
        alvo.location.y - boss.location.y,
        alvo.location.z - boss.location.z
    );
    if (dist > ALCANCE) return;

    apontar(boss, alvo);

    const agora = system.currentTick;

    // encostado: sai dali antes de mais nada
    if (dist < PERTO_DEMAIS && agora - mem.ultimoSalto >= SALTO_RECARGA) {
        if (saltarParaTras(boss, alvo)) {
            mem.ultimoSalto = agora;
            mem.lado = -mem.lado;
            return;
        }
    }

    // sem vista nao ha magia: nada de lancar atraves de paredes
    if (!temVista(boss.dimension, boss.getHeadLocation(), centro(alvo))) return;

    if (dist > PERTO_DEMAIS && dist < LONGE_DEMAIS) rodear(boss, alvo, mem);

    const pressa = mem.furioso ? PRESSA_FURIA : 1.0;
    for (const magia of REPERTORIO) {
        if (magia.soFurioso && !mem.furioso) continue;
        if (dist > alcanceDe(magia.id)) continue;
        // perto de mais: a tempestade nascia em cima dele proprio
        if (dist < magia.minimo) continue;
        if (agora - (mem.recargas[magia.id] ?? -9999) < magia.recarga * pressa) continue;

        mostrarLancamento(boss);
        let correu = false;
        try {
            // a mesma porta por onde o jogador lanca, com os mesmos numeros
            correu = executeSpell(boss, magia.id, false, magia.modificadores) !== false;
        } catch (err) {
            console.warn("[Arcano do Raio] " + magia.id + " falhou: " + err);
        }
        // Mesmo falhada a magia conta, senao ele tenta a mesma a cada tick
        mem.recargas[magia.id] = agora;
        if (correu) return;
    }
}

system.runInterval(() => {
    const vistos = new Set();
    for (const jogador of world.getAllPlayers()) {
        let bosses;
        try {
            bosses = jogador.dimension.getEntities({
                location: jogador.location,
                maxDistance: ALCANCE + 8,
                families: [FAMILIA]
            });
        } catch { continue; }
        for (const boss of bosses) {
            if (vistos.has(boss.id)) continue;
            vistos.add(boss.id);
            try { pensar(boss); } catch { }
        }
    }

    // esquece os que ja morreram
    if (memoria.size > 16) {
        for (const [id] of memoria) {
            if (!vistos.has(id)) memoria.delete(id);
        }
    }
}, PENSAR);

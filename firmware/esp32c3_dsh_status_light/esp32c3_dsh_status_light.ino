/*
 * ESP32-C3 红绿灯 —— DSH 工作状态灯（固件）
 * ============================================================================
 *
 * 硬件接线（共阴极玩具红绿灯模块，三颗独立灯珠）
 * ---------------------------------------------------------------------------
 *   灯板公共端 GND  ────  开发板 GND
 *   红灯信号线      ────  GPIO 5
 *   黄灯信号线      ────  GPIO 6
 *   绿灯信号线      ────  GPIO 7
 *
 *   ⚠️ 这份接线表是 2026-09-14 实测标定出来的，不是按颜色顺序想当然定的。
 *      最初版本写的是「黄5/绿6/红7」，烧上去后发 error 亮了绿灯、发 thinking 亮了红灯，
 *      据此反推出真实接法如上（与下面 PIN_* 常量一致）。
 *      改动接线后必须重新标定，否则整条灯语会错位。
 *
 *   共阴 = 公共端接负极，GPIO 输出高电平点亮。对应下面 ACTIVE_LOW = false。
 *   如果你以后换了共阳模块，把 ACTIVE_LOW 改成 true 并把公共端接到 3V3。
 *
 *   ★ 三颗灯珠是物理独立的，所以「黄灯呼吸 + 绿灯常亮」这类组合是真实可见的
 *     两个颜色同时亮，不会混色。固件因此采用「每颗灯独立驱动」的模型，
 *     而不是单一状态机。
 *
 * 为什么是 GPIO 5/6/7
 * ---------------------------------------------------------------------------
 *   ESP32-C3-MINI-1 模组只引出 15 个 GPIO：0,1,2,3,4,5,6,7,8,9,10,18,19,20,21。
 *   必须避开：
 *     - GPIO18 / GPIO19   原生 USB D- / D+，一旦占用 USB 会掉线
 *     - GPIO2 / GPIO8 / GPIO9  绑带引脚，上电瞬间被采样决定启动模式
 *                              （且 GPIO8 上还挂着板载蓝灯）
 *     - GPIO20 / GPIO21   UART0，留给串口调试与烧录
 *   剩下可用：3, 4, 5, 6, 7, 10 —— 这里用 5/6/7，三脚在排针上相邻，接线美观。
 *
 * Arduino IDE 板子设置
 * ---------------------------------------------------------------------------
 *   开发板：ESP32C3 Dev Module
 *   USB CDC On Boot: Enabled      ← 必须，否则串口看不到任何输出
 *   Flash Size: 4MB (32Mb)   Flash Mode: DIO   Flash Frequency: 40MHz
 *   （后三项与商家资料 flasher_args.json 一致，Arduino 默认值是 QIO/80MHz）
 *
 * ============================================================================
 * 线协议
 * ============================================================================
 *   电脑 → 板子（每行一条，\n 结尾）：
 *
 *     off              三颗灯全灭
 *
 *     thinking         黄灯呼吸
 *     busy             绿灯慢闪
 *     error            红灯常亮
 *     alarm            黄灯快闪
 *     success          绿灯常亮
 *     plan             绿灯常亮（计划模式背景）
 *
 *     thinking+plan    黄灯呼吸 + 绿灯常亮      ← 计划模式下模型在思考
 *     busy+plan        绿灯慢闪 + 绿灯常亮      ← 计划模式下工具在执行
 *     error+plan       红灯常亮 + 绿灯常亮
 *     alarm+plan       黄灯快闪 + 绿灯常亮
 *     success+plan     绿灯常亮
 *
 *     notify           绿灯快闪两下（0.15s 亮 / 0.15s 灭 ×2），
 *                      然后自动回到「闪烁前的那一刻状态」
 *     notify <state>   绿灯快闪两下，然后切到 <state>
 *
 *   板子 → 电脑：
 *     ESP32_STATUS_LIGHT READY   上电握手（插件靠它确认板子在）
 *     OK <cmd>                   执行回执
 *     ERR unknown <text>         无法识别的命令
 *
 *   ★ notify 闪烁期间，其他状态命令**照常执行**（不会被忽略），
 *     但如果它真的改变了状态，闪烁结束时**落到那个新状态**，而不是回滚到闪烁前的旧状态。
 *
 *     旧版这里的注释写的是「其他状态命令会被暂时忽略」——**那是错的**，而且
 *     实际情况比"忽略"更糟：命令先被应用、闪完再被覆盖回旧值，是三种可能里
 *     唯一会坏的一种（"忽略"无害，"应用"也无害）。真机 bug 与修法见
 *     applyCommand 里清空 savedState 的那段注释。
 * ============================================================================
 */

#include <Arduino.h>

// ===== 引脚定义 =====
// ⚠️ 这三行是**按实测接线标定**的，不是按"颜色顺序"猜的。
//    2026-09-14 硬件验证时发现：发 error（本想点亮红灯）结果绿灯亮了，
//    发 thinking（本想点亮黄灯）结果红灯亮了。据此反推出实际接线是
//      GPIO5 = 红、GPIO6 = 黄、GPIO7 = 绿
//    这恰好也是前人 esp32c3_ai_status_led.ino 里的定义（PIN_RED=5/YELLOW=6/GREEN=7），
//    即最初那一版是我把颜色名套错了引脚。
//    以后改接线，必须重新标定这三行，否则灯语会整体错位。
const uint8_t PIN_RED    = 5;   // 红：出错了
const uint8_t PIN_YELLOW = 6;   // 黄：模型在思考 / 等你确认
const uint8_t PIN_GREEN  = 7;   // 绿：工具执行 / 任务完成 / 计划模式

// 共阳模块改成 true（公共端接 3V3，GPIO 拉低点亮）
const bool ACTIVE_LOW = false;

const uint32_t SERIAL_BAUD = 115200;

// LED PWM（LEDC）：ESP32 Arduino 核心 3.x 起 API 改为「按引脚」操作，
// 旧的 ledcSetup()/ledcAttachPin() 已移除。
const uint32_t PWM_FREQ = 1000;   // 1 kHz，肉眼无闪烁
const uint8_t  PWM_BITS = 10;     // 10 位 → 0..1023
const uint16_t PWM_MAX  = (1u << PWM_BITS) - 1;   // 1023
const uint16_t PWM_MIN  = 20;                     // 呼吸最暗点，不彻底灭

/**
 * 呼吸周期（毫秒）。黄灯呼吸与绿灯”工具在执行“呼吸共用这个周期，
 * 但绿灯相位错开半周期 —— 见 LAMP_SLEEP。
 *
 * ⚠️ 插件的 `busyCooldownMs`（默认 2500）必须 ≥ 这个值，否则工具结束后
 *    绿灯会被提前熄灭，连一个完整的渐亮渐暗都看不到（看起来像闪一下）。
 */
const uint16_t BREATHE_PERIOD_MS = 2400;

/**
 * 「工具尾窗」：最后一个工具结束后，绿灯再多留一个完整呼吸周期才熄灭。
 *
 * ============================================================================
 * 为什么这个延时在【固件】里，而不是在电脑端的插件里 —— 刻意的架构决定：
 *   1. 灯效的渲染与时序是固件的职责。插件只负责“报告事实”（当前状态 + 有无工具在跑），
 *      不负责“什么时候关灯”。
 *   2. 若尾巴放在插件里，绿灯就会有一个「必须靠下一条命令才能结束」的中间态：
 *      插件崩了 / 串口断了 / DSH 卡住时，绿灯会卡在渐亮的尾巴上一直亮着。
 *      放在固件里，任何情况下固件都能自己收尾。
 *   3. 调整观感（尾巴想长/短一点）只需改这个常量并重烧，不必动插件。
 *
 * 取一个呼吸周期的长度：保证至少走完一次完整的“渐亮渐暗”，
 * 否则工具只跑几百毫秒时绿灯刚亮就被掐掉，观感像“闪了一下”。
 * ============================================================================
 */
const uint32_t TOOLS_HOLD_MS = BREATHE_PERIOD_MS;

/** 工具尾窗硬上限：万一插件一直没发 tools off，也不让绿灯永远留着。 */
const uint32_t TOOLS_HOLD_MAX_MS = 10000;

// 安全兜底：这么久没收到任何命令就自动全灭（防止电脑异常退出后灯卡住）
const uint32_t STALE_TIMEOUT_MS = 300000UL;   // 5 分钟

// notify 闪烁节奏：0.15s 亮 / 0.15s 灭 × 2
const uint16_t NOTIFY_ON_MS  = 150;
const uint16_t NOTIFY_OFF_MS = 150;
const uint8_t  NOTIFY_BLINKS = 2;

// ===== 单颗灯的效果类型 =====
enum LampEffect {
  LAMP_OFF,
  LAMP_SOLID,     // 常亮
  LAMP_BREATHE,   // 呼吸（黄灯“思考”）
  LAMP_SLEEP,     // 相位错开的同频呼吸（绿灯“工具在执行”）。
                  // 与 LAMP_BREATHE 同频率但错开半个周期：黄绿一起呼吸时
                  // 看得出是两盏灯在交替明暗，而不是同亮同暗（那样像一盏灯在闪）
  LAMP_SLOW_BLINK,// 慢闪 1.2s 周期
  LAMP_FAST_BLINK // 快闪 0.28s 周期（黄灯“等你确认”）
};

struct Lamp {
  uint8_t  pin;
  LampEffect effect;
};

Lamp lampYellow = { PIN_YELLOW, LAMP_OFF };
Lamp lampGreen  = { PIN_GREEN,  LAMP_OFF };
Lamp lampRed    = { PIN_RED,    LAMP_OFF };

// ===== 状态 =====
String   currentState = "off";
uint32_t lastCommandMs = 0;

/**
 * 是否有工具在执行（由插件通过独立的 `tools on` / `tools off` 命令报告）。
 *
 * 这是固件唯一的「跨命令」灯效状态，也是尾窗的归属所在：
 *   - `tools on`  → 立即置位，取消任何待执行的尾窗
 *   - `tools off` → 不立即熄灭，而是标记“本周期结束后开始收尾”，
 *                  由 updateEffects() 在绿灯走完一个完整呼吸周期后清掉
 */
bool     toolsActive        = false;
/** 正在等待尾窗结束（收到了 tools off，但呼吸周期还没走完）。 */
bool     toolsHoldPending   = false;
/** 收到 tools off 的时刻，用于计算尾窗是否走完。 */
uint32_t toolsOffAtMs       = 0;

// notify 覆盖层
bool     notifyActive  = false;
uint32_t notifyStartMs = 0;
String   notifyAfter   = "";     // 闪完之后切到的状态；空 = 回到闪烁前的状态
String   savedState    = "";     // 闪烁前的状态快照。
                                 // ⚠️ 闪烁期间若有**新的状态命令真的改变了状态**，
                                 //    这里会被清空，让闪完落到新状态而不是回滚到旧的。
                                 //    详见 applyCommand 里清空它的那段注释。

// ===== 底层输出 =====
void writeLed(uint8_t pin, uint16_t brightness) {
  if (brightness > PWM_MAX) brightness = PWM_MAX;
  uint32_t duty = ACTIVE_LOW ? (PWM_MAX - brightness) : brightness;
  ledcWrite(pin, duty);
}

// 三角波：periodMs 内从 PWM_MIN 升到最大再降回来
uint16_t breatheValue(uint32_t nowMs, uint16_t periodMs) {
  uint32_t phase = nowMs % periodMs;
  uint32_t half  = periodMs / 2;
  if (phase < half) return (uint16_t)map(phase, 0, half, PWM_MIN, PWM_MAX);
  return (uint16_t)map(phase, half, periodMs, PWM_MAX, PWM_MIN);
}

// 把一颗灯的效果渲染成亮度
uint16_t renderLamp(const Lamp &lamp, uint32_t nowMs) {
  switch (lamp.effect) {
    case LAMP_SOLID:      return PWM_MAX;
    case LAMP_BREATHE:    return breatheValue(nowMs, BREATHE_PERIOD_MS);
    case LAMP_SLEEP:      return breatheValue(nowMs + BREATHE_PERIOD_MS / 2, BREATHE_PERIOD_MS);
    case LAMP_SLOW_BLINK: return ((nowMs / 600) % 2 == 0) ? PWM_MAX : 0;
    case LAMP_FAST_BLINK: return ((nowMs / 140) % 2 == 0) ? PWM_MAX : 0;
    case LAMP_OFF:
    default:              return 0;
  }
}

void allLampsOff() {
  lampYellow.effect = LAMP_OFF;
  lampGreen.effect  = LAMP_OFF;
  lampRed.effect    = LAMP_OFF;
}

// ===== 状态 → 每颗灯的独立效果 =====
// planMode = 计划模式是否处于激活状态（作为背景常亮绿灯）
// 这些是“不随时间变化”的效果分配；随时间变化的部分（工具尾窗）在
// updateEffects() 里处理，因为它需要跨周期地记忆状态。
void applyStateEffects(const String &state, bool planMode) {
  allLampsOff();

  if (state == "thinking") {
    lampYellow.effect = LAMP_BREATHE;
  } else if (state == "busy") {
    lampGreen.effect = LAMP_SLOW_BLINK;
  } else if (state == "error") {
    lampRed.effect = LAMP_SOLID;
  } else if (state == "alarm") {
    lampYellow.effect = LAMP_FAST_BLINK;
  } else if (state == "success") {
    lampGreen.effect = LAMP_SOLID;
  } else if (state == "plan") {
    lampGreen.effect = LAMP_SOLID;
  }
  // state == "off" → 已全部熄灭

  // 计划模式是「背景」：额外把绿灯点亮。
  // 因为三颗灯珠独立，绿色与黄/红同时亮是真实可见的两个颜色，不会混色。
  if (planMode) {
    lampGreen.effect = LAMP_SOLID;
  }
}

/**
 * 叠加「工具在执行」的绿灯效果，并负责尾窗收尾。由 loop() 每轮调用。
 *
 * 这里是固件里唯一带时间记忆的灯效逻辑：
 *   - 工具在跑        → 绿灯以错开半周期的同频呼吸陪着黄灯一起动
 *   - 收到 tools off  → 不立即熄灭；等走完一个完整呼吸周期（TOOLS_HOLD_MS）再熄灭
 *   - 尾窗期间又来工具 → 取消收尾，继续呼吸
 *   - 超过硬上限      → 强制熄灭（防止插件异常时绿灯永远留着）
 *
 * 为什么不用「绿灯常亮」表示工具在跑：那样会与计划模式的绿灯常亮撞车，分不出来。
 */
void updateToolsEffect(uint32_t nowMs) {
  // ---- 尾窗收尾：时间到了就把工具状态清掉，并【撤销】绿灯效果 ----
  //
  // ⚠️ 这里必须自己撤销，不能只清标志位。
  //    本函数只做"叠加"（toolsActive 时把绿灯设成 LAMP_SLEEP），
  //    如果收尾时只把 toolsActive 置 0 而不恢复绿灯的基础效果，
  //    绿灯就会一直保持 LAMP_SLEEP 直到下一条状态命令 ——
  //    真机实测到的现象就是"绿灯一直亮到最后的 off 才灭"，
  //    也就是说尾巴看起来完全没生效。这是本函数唯一会被"撤销"的场景。
  if (toolsActive && toolsHoldPending) {
    const uint32_t waited = nowMs - toolsOffAtMs;
    const bool expired = waited >= TOOLS_HOLD_MS;
    const bool overCap = waited >= TOOLS_HOLD_MAX_MS;   // 兜底：不能永远留着
    if (expired || overCap) {
      toolsActive = false;
      toolsHoldPending = false;
      // 重新应用一遍基础状态效果，把绿灯从 LAMP_SLEEP 恢复过来
      applyStateEffects(currentState, currentState.endsWith("+plan"));
      return;
    }
  }

  // ---- 叠加绿灯呼吸 ----
  // 只在 thinking 前景下叠加（与 applyStateEffects 的分支保持一致），
  // 且只在绿灯当前没有被 solid（计划模式背景）占据时叠加。
  if (toolsActive && currentState.startsWith("thinking") && lampGreen.effect != LAMP_SOLID) {
    lampGreen.effect = LAMP_SLEEP;
  }
}

/** 收到 tools on：立即置位并取消任何待执行的收尾。 */
void onToolsOn(uint32_t nowMs) {
  toolsActive = true;
  toolsHoldPending = false;
}

/**
 * 收到 tools off：标记“本周期结束后开始收尾”。
 *
 * 注意不是立即熄灭 —— 这正是「呼吸要走完一个完整周期」这个需求在固件里的落点。
 */
void onToolsOff(uint32_t nowMs) {
  if (!toolsActive) return;          // 本来就没亮，什么都不用做
  if (toolsHoldPending) {
    // 已经在收尾中又被要求收尾：不重置计时，否则连续 tools off 会把尾巴无限拖长
    return;
  }
  toolsHoldPending = true;
  toolsOffAtMs = nowMs;
}

/** 清掉工具状态（用于 off / error / alarm 等“这段作废”的场景）。 */
void resetTools() {
  toolsActive = false;
  toolsHoldPending = false;
}

// ===== 命令解析 =====
// 返回 true 表示命令被接受
bool applyCommand(const String &raw) {
  String cmd = raw;
  cmd.trim();
  cmd.toLowerCase();
  if (cmd.length() == 0) return false;

  // ---- notify [after] ----
  if (cmd == "notify" || cmd.startsWith("notify ")) {
    String after = "";
    if (cmd.length() > 7) {
      after = cmd.substring(7);
      after.trim();
    }
    // 记住“闪烁前”的状态；若已经在闪，则沿用最早的那份快照
    if (!notifyActive) savedState = currentState;
    notifyAfter  = after;
    notifyActive = true;
    notifyStartMs = millis();
    return true;
  }

  // ---- 工具状态：独立命令 ----
  // 刻意做成独立命令（而不是在状态名里加修饰符），因为「有无工具在跑」是一个
  // 与前景状态正交的事实。插件只报告事实，怎么渲染由固件决定。
  // 也因此插件永远不需要知道"黄灯该不该呼吸"这类视觉细节。
  if (cmd == "tools" || cmd.startsWith("tools ")) {
    String arg = cmd.length() > 6 ? cmd.substring(6) : String("");
    arg.trim();
    if (arg == "on" || arg == "1" || arg == "true") {
      onToolsOn(millis());
      return true;
    }
    if (arg == "off" || arg == "0" || arg == "false") {
      onToolsOff(millis());
      return true;
    }
    return false;   // tools 后面跟了不认识的东西
  }

  // ---- 普通状态 ----
  // 唯一修饰符是 +plan（例如 thinking+plan）
  String rest = cmd;

  bool planMode = false;
  if (rest.endsWith("+plan")) {
    planMode = true;
    rest = rest.substring(0, rest.length() - 5);
    rest.trim();
  }

  const String base = rest;

  bool known = (base == "off" || base == "idle" ||
                base == "thinking" || base == "think" ||
                base == "busy" ||
                base == "error" || base == "fail" ||
                base == "alarm" || base == "wait" ||
                base == "success" || base == "done" ||
                base == "plan");
  if (!known) return false;

  String canon = base;
  if (canon == "idle")  canon = "off";
  if (canon == "think") canon = "thinking";
  if (canon == "fail")  canon = "error";
  if (canon == "wait")  canon = "alarm";
  if (canon == "done")  canon = "success";

  const String nextState = planMode ? (canon + "+plan") : canon;

  // ⚠️ 关键：状态**真的**变了，且此刻正在闪 notify —— 把那份"闪烁前的快照"作废。
  //
  // 不作废的话会出现这个坏序列（真机 bug）：
  //   notify（裸的）→ 拍快照 savedState="thinking" → 600ms 内 turn/end 到达
  //   → 这里把 currentState 设成 "success"，灯切绿
  //   → 闪完 target = notifyAfter（空）→ target = savedState = "thinking"
  //   → **把刚设好的 success 覆盖回旧的 thinking**
  // 而插件那边 #base 已是 success、去重后不会再发，于是灯一直错到下一次真实状态变化。
  //
  // 为什么是"清空快照"而不是"置个标志位"：清空之后，闪烁结束时的兜底链
  //   target = notifyAfter（空）→ savedState（空）→ currentState
  // 自然落到**新到的**状态，即"最新命令赢"。若改成在结束时特判标志位，
  // 就得同时处理 notify 与 notify <state> 两种命令，容易漏。
  //
  // 只在**值真的变了**时才清：重复的同值命令不该改变"闪完回到闪烁前状态"这个语义。
  if (notifyActive && nextState != currentState) {
    savedState = "";
  }

  currentState = nextState;

  // 这些状态意味着「工具那段已经结束」，顺手清掉工具状态，
  // 避免出错/收尾之后绿灯还挂着一个不再有意义的呼吸。
  if (canon == "off" || canon == "error" || canon == "alarm" || canon == "success") {
    resetTools();
  }

  applyStateEffects(canon, planMode);
  return true;
}

// ===== 开机电自检：红→黄→绿 各亮 0.4 秒 =====
void selfTest() {
  Serial.println("ESP32_STATUS_LIGHT SELFTEST");
  writeLed(PIN_RED, PWM_MAX);    delay(400); writeLed(PIN_RED, 0);
  writeLed(PIN_YELLOW, PWM_MAX); delay(400); writeLed(PIN_YELLOW, 0);
  writeLed(PIN_GREEN, PWM_MAX);  delay(400); writeLed(PIN_GREEN, 0);
  delay(200);
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(300);

  ledcAttach(PIN_YELLOW, PWM_FREQ, PWM_BITS);
  ledcAttach(PIN_GREEN,  PWM_FREQ, PWM_BITS);
  ledcAttach(PIN_RED,    PWM_FREQ, PWM_BITS);

  allLampsOff();
  selfTest();

  // 上电握手：电脑端的插件靠这一行确认板子在，并立刻补发当前状态
  Serial.println("ESP32_STATUS_LIGHT READY");

  lastCommandMs = millis();
}

void loop() {
  const uint32_t now = millis();

  // ---- 读串口，逐行解析 ----
  static String buffer = "";
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (buffer.length() > 0) {
        String line = buffer;
        buffer = "";
        line.trim();
        if (line.length() > 0) {
          if (applyCommand(line)) {
            Serial.print("OK ");
            Serial.println(line);
            lastCommandMs = now;
          } else {
            Serial.print("ERR unknown ");
            Serial.println(line);
          }
        }
      }
    } else if (buffer.length() < 64) {
      buffer += c;
    }
  }

  // ---- notify 覆盖层：闪烁期间独占控制权 ----
  if (notifyActive) {
    const uint32_t totalMs = (uint32_t)(NOTIFY_ON_MS + NOTIFY_OFF_MS) * NOTIFY_BLINKS;
    // ⚠️ 这里必须【现读】millis()，不能复用循环开头那个 `now`。
    //    原因：notifyStartMs 是在本循环中段解析命令时用 millis() 赋的，
    //    而 `now` 是循环开头读的，可能比它小 1ms。uint32_t 相减下溢成
    //    4294967295，`>= totalMs` 立刻成立 —— 闪烁会在第一轮就"完成"，一下都不闪。
    //    这个 bug 在真机上一测就现形（窗口 0ms），静态读代码看不出来。
    const uint32_t nowNotify = millis();
    if ((uint32_t)(nowNotify - notifyStartMs) >= totalMs) {
      notifyActive = false;
      // 闪烁结束：切到指定状态，或回到闪烁前的状态
      String target = notifyAfter;
      if (target.length() == 0) target = savedState;
      if (target.length() == 0) target = "off";
      applyCommand(target);
      Serial.print("OK notify -> ");
      Serial.println(target);
    } else {
      const uint32_t phase = (uint32_t)(nowNotify - notifyStartMs) % (NOTIFY_ON_MS + NOTIFY_OFF_MS);
      const uint16_t g = (phase < NOTIFY_ON_MS) ? PWM_MAX : 0;
      writeLed(PIN_GREEN, g);
      writeLed(PIN_YELLOW, 0);
      writeLed(PIN_RED, 0);
      delay(5);
      return;   // 闪烁期间不渲染普通状态
    }
  }

  // ---- 安全兜底：太久没收到命令就全灭 ----
  if (currentState != "off" && (now - lastCommandMs) > STALE_TIMEOUT_MS) {
    currentState = "off";
    allLampsOff();
    resetTools();
  }

  // ---- 叠加「工具在执行」的绿灯效果，并处理尾窗收尾 ----
  // 放在渲染之前：updateToolsEffect 可能会清掉 toolsActive，从而影响这一帧。
  // 注意这里现读 millis()，理由同 notify 分支 —— 尾窗计时是命令处理中段设置的。
  updateToolsEffect(millis());

  // ---- 渲染每颗灯（彼此独立） ----
  writeLed(PIN_YELLOW, renderLamp(lampYellow, now));
  writeLed(PIN_GREEN,  renderLamp(lampGreen,  now));
  writeLed(PIN_RED,    renderLamp(lampRed,    now));

  delay(5);
}

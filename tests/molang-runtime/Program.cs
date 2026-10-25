using System.Text;
using System.Text.Json;
using YSMViewer.Services.Molang;

static double?[] Evaluate(BrowserMolangEvaluator evaluator, double local = 0.25, double elapsed = 1.25)
{
    using var result = JsonDocument.Parse(evaluator.Evaluate(local, elapsed, 0.016));
    return result.RootElement.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.Null
        ? (double?)null : item.GetDouble()).ToArray();
}

static void Equal(double? actual, double expected, string label)
{
    if (actual is not double value || !double.IsFinite(value) || Math.Abs(value - expected) > 0.0001)
        throw new Exception($"{label}: expected {expected}, actual {actual}");
}

static void Configure(BrowserMolangEvaluator evaluator, params string[] expressions)
    => evaluator.Configure(JsonSerializer.Serialize(expressions));

var evaluator = new BrowserMolangEvaluator();
Configure(evaluator, "ysm.head_yaw", "5+ysm.head_yaw", "ysm.head_pitch",
    "math.sin(query.anim_time*360)", "query.life_time", "query.delta_time", "ysm.time_delta");
var first = Evaluate(evaluator);
Equal(first[0], 0, "neutral yaw"); Equal(first[1], 5, "constant term preserved");
Equal(first[2], 0, "neutral pitch"); Equal(first[3], 1, "time-dependent degree sine");
Equal(first[4], 0.25, "loop-local life_time"); Equal(first[5], 0.016, "delta_time");
Equal(first[6], 0.016, "YSM delta alias");

evaluator.SetVariable("ysm.head_yaw", 25);
evaluator.SetVariable("ysm.head_pitch", -12);
var changed = Evaluate(evaluator, 0.75, 1.75);
Equal(changed[0], 25, "live yaw context"); Equal(changed[1], 30, "live arithmetic");
Equal(changed[2], -12, "live pitch context"); Equal(changed[3], -1, "time changes without reload");
Equal(changed[4], 0.75, "changed loop-local time");

var aliases = new BrowserMolangEvaluator();
aliases.SetVariable("head_x_rotation", 11); aliases.SetVariable("head_y_rotation", -7);
Configure(aliases, "ysm.head_yaw", "ysm.head_pitch", "query.head_x_rotation", "query.head_y_rotation");
var mapped = Evaluate(aliases);
Equal(mapped[0], 11, "documented yaw alias"); Equal(mapped[1], -7, "documented pitch alias");
Equal(mapped[2], 11, "original query preserved"); Equal(mapped[3], -7, "original pitch query preserved");

evaluator.Service.RegisterFunction("turn", Encoding.UTF8.GetBytes("return 5+ysm.head_yaw;"));
Configure(evaluator, "fn.turn()", "variable.offset = 3; return variable.offset + ysm.head_yaw;",
    "ysm.head_yaw > 0 ? 2 : 1");
var language = Evaluate(evaluator);
Equal(language[0], 30, "model function"); Equal(language[1], 28, "assignment and return");
Equal(language[2], 2, "conditional expression");

Configure(evaluator, "(", "math.sqrt(-1)", "5+variable.uninitialized");
var invalid = Evaluate(evaluator);
if (invalid[0] is not null || invalid[1] is not null)
    throw new Exception("Parse and nonfinite failures must be explicit null samples, not silent zero values");
Equal(invalid[2], 5, "uninitialized variables follow MoLang zero semantics");
bool rejected = false;
try { evaluator.SetVariable("ysm.head_yaw", double.NaN); }
catch (ArgumentOutOfRangeException) { rejected = true; }
if (!rejected) throw new Exception("Nonfinite preview context must be rejected");

Configure(evaluator, "ysm.head_yaw", "query.anim_time", "query.life_time");
var restarted = Evaluate(evaluator, 0, 0);
Equal(restarted[0], 25, "clip switch retains user context");
Equal(restarted[1], 0, "restart resets total time"); Equal(restarted[2], 0, "restart resets local time");
var nextModel = new BrowserMolangEvaluator();
Configure(nextModel, "ysm.head_yaw", "variable.offset");
var cleared = Evaluate(nextModel);
Equal(cleared[0], 0, "model change clears head context"); Equal(cleared[1], 0, "model change clears variables");

Console.WriteLine("PASS: actual MoLang runtime — neutral/nonzero context, arithmetic, time/loops, aliases, custom functions, failures and lifecycle");

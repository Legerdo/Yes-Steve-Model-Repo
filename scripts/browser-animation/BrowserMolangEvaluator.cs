using ConcreteMC.MolangSharp.Parser;
using ConcreteMC.MolangSharp.Parser.Exceptions;
using ConcreteMC.MolangSharp.Runtime;
using ConcreteMC.MolangSharp.Runtime.Struct;
using ConcreteMC.MolangSharp.Runtime.Value;
using ConcreteMC.MolangSharp.Utils;
using System.Text;
using System.Text.Json;

namespace YSMViewer.Services.Molang;

// Reuses YSMViewer's parser, math/functions and variable scopes. Compiled
// expressions live for one model; only the selected clip is evaluated per frame.
public sealed class BrowserMolangEvaluator
{
    private readonly Dictionary<string, IExpression?> _cache = new(StringComparer.Ordinal);
    private IExpression?[] _active = [];
    public MolangService Service { get; }

    public BrowserMolangEvaluator()
    {
        Service = new MolangService(environment =>
        {
            environment.Structs["ysm"] = new PreviewYsmStruct(environment.Structs["ysm"],
                () => Service ?? throw new InvalidOperationException("MoLang runtime is not initialized"));
        });
    }

    public void Configure(string expressionsJson)
    {
        using var json = JsonDocument.Parse(expressionsJson);
        var expressions = new List<IExpression?>();
        foreach (var item in json.RootElement.EnumerateArray())
        {
            var source = item.GetString() ?? string.Empty;
            if (!_cache.TryGetValue(source, out var expression))
            {
                try { expression = MoLangParser.Parse(source); }
                catch (MoLangParserException) { expression = null; }
                _cache[source] = expression;
            }
            expressions.Add(expression);
        }
        _active = [.. expressions];
        Service.ResetPhysics();
    }

    public void SetVariable(string name, double value)
    {
        if (!float.IsFinite((float)value)) throw new ArgumentOutOfRangeException(nameof(value));
        Service.SetUserVariable(name, (float)value);
    }

    public string Evaluate(double localTime, double elapsedTime, double deltaTime)
    {
        var delta = FiniteTime(deltaTime);
        Service.ResetFrame(delta);
        // YSM's documented timeline uses total playback time for anim_time and
        // the current loop's time for life_time (wiki/molang/ref).
        Service.SetAnimVariable("anim_time", FiniteTime(elapsedTime));
        Service.SetUserVariable("life_time", FiniteTime(localTime));
        Service.SetAnimVariable("delta_time", delta);
        Service.SetAnimVariable("frame_time", delta);

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (var expression in _active)
            {
                float value = float.NaN;
                if (expression is not null)
                {
                    try { value = Service.EvaluateStrict(expression); }
                    catch (Exception) { /* Null is an explicit failed sample, never a successful zero. */ }
                }
                if (float.IsFinite(value)) writer.WriteNumberValue(value);
                else writer.WriteNullValue();
            }
            writer.WriteEndArray();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static float FiniteTime(double value) => float.IsFinite((float)value) ? (float)value : 0f;

    private sealed class PreviewYsmStruct(IMoStruct native, Func<MolangService> getService) : IMoStruct
    {
        public object Value => this;
        public IMoValue Get(MoPath key, MoParams parameters)
        {
            var service = getService();
            if (!key.HasChildren)
            {
                if (service.UserVariables.TryGetValue("ysm." + key.Value, out var value)) return value;
                // Aliases defined by https://yesstevemodel.github.io/wiki/molang/ref/
                // Game-state inputs retain their neutral preview values until set.
                switch (key.Value.ToLowerInvariant())
                {
                    case "head_yaw": return new DoubleValue(service.SafeGetUserVar("head_x_rotation"));
                    case "head_pitch": return new DoubleValue(service.SafeGetUserVar("head_y_rotation"));
                    case "time_delta": return new DoubleValue(service.SafeGetUserOrAnimVar("delta_time"));
                }
            }
            return native.Get(key, parameters);
        }
        public void Set(MoPath key, IMoValue value) => native.Set(key, value);
        public void Clear() => native.Clear();
    }
}

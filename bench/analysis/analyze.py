# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas>=2.2", "numpy>=1.26", "scipy>=1.13", "statsmodels>=0.14", "scikit-learn>=1.5", "matplotlib>=3.8"]
# ///
"""
Analysis of the benchmark dataset (bench/results/_dataset/runs.csv, made by bench/export.mjs).

    uv run bench/analysis/analyze.py [--ref gearmod] [--base baseline]

Writes bench/results/_analysis/: report.md (every number of the article's results section), CSV tables and PNG figures.
Unit of analysis = a question unit (repository, question, variant) with one agent; repetitions are averaged inside it,
so comparisons between configurations are paired on the same question.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

import os
BENCH = Path(__file__).resolve().parents[1]
# data lives outside the Git repository (see bench/lib/util.mjs)
ROOT = Path(os.environ["BENCH_DATA"]).resolve() if os.environ.get("BENCH_DATA") else BENCH.parent.parent / "bench-data"
DATA = ROOT / "results" / "_dataset"
OUT = ROOT / "results" / "_analysis"
RNG = np.random.default_rng(20261103)
ABLATIONS = ["abl-types", "abl-terms", "abl-lines", "abl-mentions", "abl-all"]

lines: list[str] = []


def say(text: str = "") -> None:
    lines.append(text)
    print(text)


def table(df: pd.DataFrame, name: str, floatfmt: str = "{:.3f}") -> None:
    df.to_csv(OUT / f"{name}.csv", index=False)
    if df.empty:
        say("_(no data)_\n")
        return
    show = df.copy()
    for col in show.columns:
        if pd.api.types.is_float_dtype(show[col]):
            show[col] = show[col].map(lambda v: "" if pd.isna(v) else floatfmt.format(v))
    say("| " + " | ".join(map(str, show.columns)) + " |")
    say("|" + "---|" * len(show.columns))
    for _, row in show.iterrows():
        say("| " + " | ".join(map(str, row.values)) + " |")
    say()


# ---------- statistics helpers ----------

def geo_ratio_ci(ratios: np.ndarray, n_boot: int = 5000) -> tuple[float, float, float]:
    """Geometric mean of paired ratios with a percentile bootstrap CI (resampling question units)."""
    logs = np.log(ratios)
    point = float(np.exp(logs.mean()))
    if len(logs) < 3:
        return point, float("nan"), float("nan")
    boots = np.exp(RNG.choice(logs, size=(n_boot, len(logs)), replace=True).mean(axis=1))
    return point, float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))


def rank_biserial(diff: np.ndarray) -> float:
    """Matched-pairs rank-biserial correlation (effect size of the Wilcoxon test): -1..1, negative = ref lower."""
    diff = diff[diff != 0]
    if len(diff) == 0:
        return 0.0
    ranks = stats.rankdata(np.abs(diff))
    return float((ranks[diff > 0].sum() - ranks[diff < 0].sum()) / ranks.sum())


def holm(pvalues: list[float]) -> list[float]:
    order = np.argsort(pvalues)
    adjusted = [float("nan")] * len(pvalues)
    running = 0.0
    m = len(pvalues)
    for rank, idx in enumerate(order):
        p = pvalues[idx]
        if math.isnan(p):
            continue
        running = max(running, min(1.0, (m - rank) * p))
        adjusted[idx] = running
    return adjusted


def cohen_kappa(a: pd.Series, b: pd.Series) -> float:
    a, b = a.astype(int), b.astype(int)
    po = float((a == b).mean())
    pe = float(a.mean() * b.mean() + (1 - a.mean()) * (1 - b.mean()))
    return (po - pe) / (1 - pe) if pe < 1 else float("nan")


# ---------- analysis ----------

def main() -> None:
    import sys
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp1252
    parser = argparse.ArgumentParser()
    parser.add_argument("--ref", default="gearmod", help="configuration under test")
    parser.add_argument("--base", default="baseline", help="configuration without code tools")
    parser.add_argument("--metric", default="cost_usd", help="cost_usd | total_input_tokens | sec | turns")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    runs = pd.read_csv(DATA / "runs.csv")
    runs["unit"] = runs["repo"] + "/" + runs["question"] + "/" + runs["variant"]
    say("# Benchmark analysis\n")
    say(f"Dataset: {len(runs)} runs, {runs['unit'].nunique()} question units, {runs['repo'].nunique()} repositories, "
        f"configurations: {', '.join(sorted(runs['config'].unique()))}; agents: {', '.join(sorted(runs['agent'].unique()))}.\n")

    # 1. validity: failed runs are reported, not silently dropped
    say("## 1. Run validity\n")
    validity = runs.groupby(["config", "agent"]).agg(runs=("ok", "size"), ok=("ok", "sum")).reset_index()
    validity["failed_share"] = 1 - validity["ok"] / validity["runs"]
    table(validity, "validity")
    ok = runs[runs["ok"] == 1].copy()

    # 2. descriptives
    say("## 2. Descriptive statistics (successful runs)\n")
    desc = ok.groupby(["config", "agent"]).agg(
        runs=("key", "size"), cost_mean=("cost_usd", "mean"), cost_median=("cost_usd", "median"),
        input_tokens_mean=("total_input_tokens", "mean"), output_tokens_mean=("output_tokens", "mean"),
        sec_mean=("sec", "mean"), turns_mean=("turns", "mean"), recall_mean=("recall", "mean"),
        judge_recall_mean=("judge_recall", "mean"), errors_mean=("errors", "mean")).reset_index()
    table(desc, "descriptives")

    # per question unit × agent × config: mean over repetitions (+ within-unit spread for the power analysis)
    unit = ok.groupby(["unit", "repo", "qtype", "lang", "agent", "config"]).agg(
        metric=(args.metric, "mean"), cost=("cost_usd", "mean"), recall=("recall", "mean"), sec=("sec", "mean"),
        reps=("key", "size"), log_sd=(args.metric, lambda s: float(np.log(s[s > 0]).std(ddof=1)) if (s > 0).sum() > 1 else np.nan),
        repo_files=("repo_files", "first"), q_identifiers=("q_identifiers", "first"), q_words=("q_words", "first"),
        repo_tier=("repo_tier", "first"), memorization=("repo_role", "first")).reset_index()
    unit.to_csv(OUT / "units.csv", index=False)
    wide = unit.pivot_table(index=["unit", "repo", "qtype", "lang", "agent"], columns="config", values="metric").reset_index()

    # 3. paired comparisons
    say(f"## 3. Paired comparisons on {args.metric} (ratio < 1 = the first configuration is cheaper)\n")
    rows = []
    configs = [c for c in sorted(ok["config"].unique())]
    pairs = [(args.ref, c) for c in configs if c != args.ref] + ([(c, args.base) for c in configs if c not in (args.ref, args.base) and not c.startswith("abl-")])
    for agent in sorted(wide["agent"].unique()):
        sub = wide[wide["agent"] == agent]
        for a, b in pairs:
            if a not in sub or b not in sub:
                continue
            paired = sub[[a, b]].dropna()
            paired = paired[(paired[a] > 0) & (paired[b] > 0)]
            if len(paired) == 0:
                continue
            ratio, lo, hi = geo_ratio_ci((paired[a] / paired[b]).to_numpy())
            diff = np.log(paired[a].to_numpy()) - np.log(paired[b].to_numpy())
            p = float(stats.wilcoxon(diff).pvalue) if len(diff) >= 6 and np.any(diff != 0) else float("nan")
            rows.append({"agent": agent, "a": a, "b": b, "units": len(paired), "ratio_geo": ratio, "ci_low": lo, "ci_high": hi,
                         "a_cheaper_share": float((diff < 0).mean()), "rank_biserial": rank_biserial(diff), "p_wilcoxon": p})
    comp = pd.DataFrame(rows)
    if not comp.empty:
        comp["p_holm"] = holm(comp["p_wilcoxon"].tolist())
    table(comp, "paired_comparisons")
    say("Wilcoxon needs at least 6 paired units; CIs need at least 3. Holm correction over all rows.\n")

    # 4. quality: non-inferiority of recall (margin 5 points)
    say("## 4. Answer quality (recall of the answer key) — non-inferiority, margin −0.05\n")
    qrows = []
    rwide = unit.pivot_table(index=["unit", "agent"], columns="config", values="recall").reset_index()
    for agent in sorted(rwide["agent"].unique()):
        sub = rwide[rwide["agent"] == agent]
        for other in [c for c in configs if c != args.ref]:
            if args.ref not in sub or other not in sub:
                continue
            paired = sub[[args.ref, other]].dropna()
            if paired.empty:
                continue
            d = (paired[args.ref] - paired[other]).to_numpy()
            boots = RNG.choice(d, size=(5000, len(d)), replace=True).mean(axis=1) if len(d) >= 3 else np.array([np.nan])
            lo = float(np.percentile(boots, 2.5)) if len(d) >= 3 else float("nan")
            qrows.append({"agent": agent, "vs": other, "units": len(d), "recall_ref": float(paired[args.ref].mean()), "recall_other": float(paired[other].mean()),
                          "diff": float(d.mean()), "ci_low": lo, "non_inferior": bool(lo > -0.05) if not math.isnan(lo) else None})
    table(pd.DataFrame(qrows), "quality_noninferiority")

    # 5. mixed-effects model
    say("## 5. Mixed-effects model: log(metric) ~ configuration + agent + question type, random intercepts for repository and question\n")
    try:
        import statsmodels.formula.api as smf
        m = ok[ok[args.metric] > 0].copy()
        m["log_y"] = np.log(m[args.metric])
        terms = [f"C(config, Treatment('{args.base}'))"]
        if m["agent"].nunique() > 1:
            terms.append("C(agent)")
        if m["qtype"].nunique() > 1:
            terms.append("C(qtype)")
        if m["repo"].nunique() >= 3:
            model = smf.mixedlm("log_y ~ " + " + ".join(terms), m, groups=m["repo"], vc_formula={"unit": "0 + C(unit)"})
        else:
            model = smf.mixedlm("log_y ~ " + " + ".join(terms), m, groups=m["unit"])
        fit = model.fit(reml=True, method="lbfgs")
        coef = fit.params.filter(like="config").to_frame("coef")
        ci = fit.conf_int().loc[coef.index]
        coef["ratio"] = np.exp(coef["coef"])
        coef["ci_low"] = np.exp(ci[0])
        coef["ci_high"] = np.exp(ci[1])
        coef["p"] = fit.pvalues.loc[coef.index]
        coef = coef.reset_index().rename(columns={"index": "term"})
        table(coef, "mixed_model")
        (OUT / "mixed_model.txt").write_text(str(fit.summary()))
        say(f"ratio = exp(coef): multiplicative effect on {args.metric} vs {args.base}, adjusted for agent and question type. Full summary in mixed_model.txt.\n")
    except Exception as error:  # small pilots do not converge
        say(f"_Mixed model not fitted ({error}); fallback: OLS with question fixed effects and errors clustered by question._\n")
        try:
            import statsmodels.formula.api as smf
            m = ok[ok[args.metric] > 0].copy()
            m["log_y"] = np.log(m[args.metric])
            extra = " + C(agent)" if m["agent"].nunique() > 1 else ""
            fit = smf.ols(f"log_y ~ C(config, Treatment('{args.base}')) + C(unit){extra}", m).fit(cov_type="cluster", cov_kwds={"groups": m["unit"].astype("category").cat.codes})
            coef = fit.params.filter(like="config").to_frame("coef")
            ci = fit.conf_int().loc[coef.index]
            coef["ratio"] = np.exp(coef["coef"])
            coef["ci_low"] = np.exp(ci[0])
            coef["ci_high"] = np.exp(ci[1])
            coef["p"] = fit.pvalues.loc[coef.index]
            table(coef.reset_index().rename(columns={"index": "term"}), "ols_fixed_effects")
        except Exception as inner:
            say(f"_Fallback not fitted either: {inner}_\n")

    # 6. ablation
    say("## 6. Ablation: what each part of the index contributes (ratio vs the full index; > 1 = turning it off costs more)\n")
    # Only the ablation block's own runs, so the full index is measured in the same block (same time, same questions).
    def block_wide(experiment: str, index: list[str]) -> pd.DataFrame:
        b = ok[ok["experiment"] == experiment]
        if b.empty:
            return pd.DataFrame()
        return b.groupby(index + ["config"])[args.metric].mean().unstack("config").reset_index()

    def ratio_row(num: pd.Series, den: pd.Series, **extra) -> dict | None:
        mask = (num > 0) & (den > 0)
        num, den = num[mask].to_numpy(), den[mask].to_numpy()
        if len(num) == 0:
            return None
        ratio, lo, hi = geo_ratio_ci(num / den)
        diff = np.log(num) - np.log(den)
        p = float(stats.wilcoxon(diff).pvalue) if len(diff) >= 6 and np.any(diff != 0) else float("nan")
        return {**extra, "units": len(num), "ratio_geo": ratio, "ci_low": lo, "ci_high": hi, "p_wilcoxon": p}

    abw = block_wide("ablation", ["unit", "agent"])
    arows = []
    for agent in sorted(abw["agent"].unique()) if not abw.empty else []:
        sub = abw[abw["agent"] == agent]
        for b in [c for c in ABLATIONS + ["gearmod-summary"] if c in sub and args.ref in sub]:
            pair = sub[[b, args.ref]].dropna()
            row = ratio_row(pair[b], pair[args.ref], agent=agent, variant=b)
            if row:
                arows.append(row)
    abl = pd.DataFrame(arows)
    if not abl.empty:
        abl["p_holm"] = holm(abl["p_wilcoxon"].tolist())
    table(abl, "ablation")
    say("Ratio = variant / full index on the same question, ablation block only. gearmod-summary is a different output format, not a removed part.\n")

    # 6b. paraphrase: does the gain depend on the wording / language?
    say(f"## 6b. Paraphrase: gain by question language ({args.ref} / {args.base}, paraphrase block only)\n")
    pw = block_wide("paraphrase", ["repo", "question", "lang", "agent"])
    prows = []
    if not pw.empty and args.ref in pw and args.base in pw:
        for (agent, lang), sub in pw.groupby(["agent", "lang"]):
            row = ratio_row(sub[args.ref], sub[args.base], agent=agent, lang=lang)
            if row:
                prows.append(row)
        # interaction: per question, log ratio in pt minus log ratio in en
        lr = pw.assign(lr=np.log(pw[args.ref]) - np.log(pw[args.base])).pivot_table(index=["repo", "question", "agent"], columns="lang", values="lr").dropna()
        if {"pt", "en"} <= set(lr.columns) and len(lr) >= 6:
            d = (lr["pt"] - lr["en"]).to_numpy()
            ratio, lo, hi = geo_ratio_ci(np.exp(d))
            prows.append({"agent": "all", "lang": "pt vs en (ratio of ratios)", "units": len(d), "ratio_geo": ratio, "ci_low": lo, "ci_high": hi,
                          "p_wilcoxon": float(stats.wilcoxon(d).pvalue)})
    table(pd.DataFrame(prows), "paraphrase")
    oracle_dir = ROOT / "results" / "_oracle"
    if oracle_dir.exists():
        orows = [json.loads(p.read_text()) for p in sorted(oracle_dir.glob("*.json"))]
        say("Edge quality against the TypeScript compiler:\n")
        table(pd.DataFrame([{"repo": o["repo"], "ablation": o.get("ablate") or "none", "index_edges_judged": o["indexEdgesJudged"], "precision": o["precision"], "recall": o["recall"]} for o in orows]), "oracle")

    # 7. when does the graph help? classifier over question features
    say(f"## 7. When does the index pay off? (y = {args.ref} cheaper than {args.base} on the same question)\n")
    if args.ref in wide and args.base in wide:
        d = wide.dropna(subset=[args.ref, args.base]).copy()
        d["y"] = (d[args.ref] < d[args.base]).astype(int)
        meta = unit.drop_duplicates(["unit", "agent"])[["unit", "agent", "repo_files", "q_identifiers", "q_words", "repo_tier"]]
        d = d.merge(meta, on=["unit", "agent"], how="left")
        d["log_files"] = np.log1p(d["repo_files"].fillna(0))
        say(f"{len(d)} paired units; {d['y'].mean():.0%} cheaper with {args.ref}.\n")
        if len(d) >= 30 and d["y"].nunique() == 2 and d["repo"].nunique() >= 3:
            from sklearn.linear_model import LogisticRegression
            from sklearn.model_selection import GroupKFold, cross_val_predict
            from sklearn.metrics import roc_auc_score
            from sklearn.tree import DecisionTreeClassifier, export_text
            X = pd.get_dummies(d[["qtype", "lang", "agent", "log_files", "q_identifiers", "q_words"]], columns=["qtype", "lang", "agent"], drop_first=True).astype(float)
            folds = GroupKFold(n_splits=min(5, d["repo"].nunique()))
            logit = LogisticRegression(max_iter=2000)
            proba = cross_val_predict(logit, X, d["y"], groups=d["repo"], cv=folds, method="predict_proba")[:, 1]
            tree = DecisionTreeClassifier(max_depth=3, min_samples_leaf=8, random_state=0)
            proba_tree = cross_val_predict(tree, X, d["y"], groups=d["repo"], cv=folds, method="predict_proba")[:, 1]
            say(f"Cross-validated AUC, grouped by repository (never tested on a repository seen in training): logistic {roc_auc_score(d['y'], proba):.2f}, tree {roc_auc_score(d['y'], proba_tree):.2f}.\n")
            logit.fit(X, d["y"])
            table(pd.DataFrame({"feature": X.columns, "coef": logit.coef_[0], "odds_ratio": np.exp(logit.coef_[0])}).sort_values("coef"), "classifier_logit")
            tree.fit(X, d["y"])
            (OUT / "classifier_tree.txt").write_text(export_text(tree, feature_names=list(X.columns)))
            say("Decision rules in classifier_tree.txt.\n")
        else:
            say("_Needs ≥ 30 paired units from ≥ 3 repositories with both outcomes; showing the share by type instead._\n")
            table(d.groupby("qtype")["y"].agg(["mean", "size"]).reset_index().rename(columns={"mean": "cheaper_share", "size": "units"}), "helps_by_type")

        # 8. scaling: gain vs repository size
        say("## 8. Scaling: gain by repository size\n")
        by_repo = d.groupby("repo").apply(lambda g: pd.Series({"files": g["repo_files"].iloc[0], "units": len(g), "ratio_geo": float(np.exp(np.log(g[args.ref] / g[args.base]).mean()))}), include_groups=False).reset_index()
        table(by_repo.sort_values("files"), "scaling")
        if len(by_repo) >= 4:
            rho, p = stats.spearmanr(by_repo["files"], by_repo["ratio_geo"])
            say(f"Spearman ρ(files, ratio) = {rho:.2f} (p = {p:.3f}); negative = the index pays off more in larger repositories.\n")
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            fig, ax = plt.subplots(figsize=(6, 4))
            ax.scatter(by_repo["files"], by_repo["ratio_geo"], color="#2563eb")
            for _, r in by_repo.iterrows():
                ax.annotate(r["repo"], (r["files"], r["ratio_geo"]), textcoords="offset points", xytext=(4, 4), fontsize=8)
            ax.axhline(1, color="#999", lw=1, ls="--")
            ax.set_xscale("log")
            ax.set_xlabel("source files (log)")
            ax.set_ylabel(f"{args.metric}: {args.ref} / {args.base}")
            fig.tight_layout()
            fig.savefig(OUT / "scaling.png", dpi=160)
        except Exception as error:
            say(f"_figure skipped: {error}_")

    # 9. break-even from indexing performance
    perf_file = ROOT / "results" / "_perf" / "perf.jsonl"
    if perf_file.exists():
        say("## 9. Indexing cost and break-even\n")
        perf = pd.read_json(perf_file, lines=True)
        ptab = perf.groupby(["repo", "measure"])["ms"].median().unstack().reset_index()
        table(ptab, "perf", "{:.0f}")
        say("Break-even: indexing is a one-off local CPU cost (seconds); the saving per question is in the comparison table. "
            "Report the number of questions after which the saved agent time exceeds the cold indexing time.\n")

    # 10. tool-use patterns (directly-follows relation, process mining light)
    calls_file = DATA / "toolcalls.csv"
    if calls_file.exists():
        say("## 10. Tool-use patterns\n")
        calls = pd.read_csv(calls_file)
        if not calls.empty:
            calls = calls.sort_values(["key", "seq"])
            calls["next"] = calls.groupby("key")["tool"].shift(-1)
            dfg = calls.dropna(subset=["next"]).groupby(["config", "tool", "next"]).size().reset_index(name="count")
            dfg = dfg.sort_values(["config", "count"], ascending=[True, False]).groupby("config").head(6)
            table(dfg, "directly_follows")
            first_graph = calls[calls["tool"].str.startswith("mcp__")].groupby("key")["seq"].min()
            reads = calls[calls["tool"].isin(["Read", "shell"])].groupby("key").size()
            say(f"Runs that used a graph tool: {first_graph.size}; median position of the first graph call: {first_graph.median() if len(first_graph) else float('nan'):.0f}. "
                f"Median reads per run: {reads.median() if len(reads) else 0:.0f}.\n")

    # 11. agreement of the automatic scoring with a person
    say("## 11. Scoring agreement with a human reviewer\n")
    reviews = []
    for review in (ROOT / "results").glob("*/review.csv"):
        r = pd.read_csv(review)
        r = r[r["human"].notna() & (r["human"].astype(str) != "")]
        if not r.empty:
            reviews.append(r)
    if reviews:
        r = pd.concat(reviews)
        r["human"] = r["human"].astype(int)
        res = {"rows": len(r), "kappa_regex": cohen_kappa(r["regex"], r["human"])}
        if r["judge"].notna().any():
            j = r[r["judge"].notna() & (r["judge"].astype(str) != "")]
            res["kappa_judge"] = cohen_kappa(j["judge"].astype(int), j["human"])
        table(pd.DataFrame([res]), "agreement")
    else:
        say("_No review.csv with the human column filled yet (bench/score.mjs --review 0.1)._\n")

    # 12. variance components for the power analysis
    say("## 12. Variance components (input of analysis/power.py)\n")
    vc = {"within_unit_log_sd": float(unit["log_sd"].dropna().mean()) if unit["log_sd"].notna().any() else None}
    if args.ref in wide and args.base in wide:
        dd = wide.dropna(subset=[args.ref, args.base])
        dd = dd[(dd[args.ref] > 0) & (dd[args.base] > 0)]
        if len(dd) >= 2:
            vc["between_unit_log_ratio_sd"] = float(np.log(dd[args.ref] / dd[args.base]).std(ddof=1))
            vc["mean_log_ratio"] = float(np.log(dd[args.ref] / dd[args.base]).mean())
    (OUT / "variance.json").write_text(json.dumps(vc, indent=2))
    say(f"```\n{json.dumps(vc, indent=2)}\n```\n")

    (OUT / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\nreport: {OUT / 'report.md'}")


if __name__ == "__main__":
    main()

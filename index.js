/*
 * A DerivedValue represents a statistic that is
 * computed from a stat, e.g. 'extra MP per tick'
 * is a value derived from the piety stat value.
 *
 * DerivedValues are automatically treated as
 * percentages when displayed by the code,
 * unless .isntPercent() is called or isPercent
 * is set to false.
 *
 * DerivedValues have their next breakpoints
 * calculated by code. The 'direction' of the
 * breakpoint, based on the calcFn, is controlled
 * by the `invertedBreakpoints` variable. By
 * default, we assume that by increasing a stat,
 * the derived value will (eventually) increase, too.
 * If this is the opposite, such as for spell speed,
 * then InvertedDerivedValue should be used instead.
 *
 * The DerivedValue calcFn is a little weird, in that
 * the actual definitions are defined way below in the
 * StatList, and the actual arguments passed into them
 * are defined in Stat. So, there's some unfortunate
 * action-at-a-distance here, but oh well.
 */
class DerivedValue {
    constructor(name, displayName, calcFn) {
        this.name = name;
        this.displayName = displayName;
        this.calcFn = calcFn;
        this.isPercent = true;
        this.invertedBreakpoints = false;
    }

    isntPercent() {
        this.isPercent = false;
        return this;
    }

    get lesserBreakpointDirection() {
        return this.invertedBreakpoints? +1 : -1;
    }

    get greaterBreakpointDirection() {
        return this.invertedBreakpoints? -1 : +1;
    }

    get hasBreakpoints() {
        return true;
    }
}

/*
 * A NoBreakpointDerivedValue typically uses intermediate
 * calculations (that depend on other derived values),
 * so there shouldn't be any breakpoint calculation done
 * on it, because our breakpoint calculation code doesn't
 * recalculate *other* derived values based on their stat,
 * if that makes sense.
 *
 * This may also be used for cases where breakpoints
 * don't make sense (such as the fixed bonus rate for
 * direct hit).
 */
class NoBreakpointDerivedValue extends DerivedValue {
    get hasBreakpoints() {
        false;
    }
}

/*
 * An InvertedDerivedValue has its derived value
 * increase as the stat decreases, or decrease as
 * the stat increases. This requires special
 * handling in our breakpoint code, which naively
 * increments/decrements the stat until it finds
 * a value that is lesser or greater than the
 * previous.
 */
class InvertedDerivedValue extends DerivedValue {
    constructor(name, displayName, calcFn) {
        super(name, displayName, calcFn);
        this.invertedBreakpoints = true;
    }
}

/*
 * Skill/Spell speed have several derived values
 * that are all very similar to one another. This
 * is a centralized place to handle that computation
 * without copy/pasting -- useful especially because
 * this was a rather tricky bit to get correct.
 */
class SpeedDerivedValue extends DerivedValue {
    constructor(baseSpeed, timeConstant) {
        super(baseSpeed, baseSpeed, (s, extra) => {
            return new Decimal(1000)
                .minus(extra)
                .times(timeConstant)
                .dividedBy(1000)
                .floor()
                .dividedBy(1000)
                .toDecimalPlaces(2, Decimal.ROUND_DOWN);
        });

        this.isPercent = false;
        this.invertedBreakpoints = true;
    }
}

/*
 * A Stat is what it sounds like. It has a name, a base value
 * (that is, the value if you had no gear on at level 80),
 * a delta 'rate' (that is, the width of statistic threshold
 * intervals), and a set of derived value definitions.
 *
 * This function is responsible for the calculation of
 * breakpoints (in this.derivedValues()), and it's also
 * the thing that ends up generating the object structure
 * used to display the derived values on the web page itself.
 * In a way, then, it could be thought of as the place
 * responsible for interfacing the technical DerivedValue
 * with the actual view code.
 */
function Stat(name, statBase, deltaRate, derivedValueDefns) {
    this.name = name;
    this.currentValue = statBase;

    const levelMod = 3300;

    /*
     * 'extra' is a weird name, but it's basically the
     * extra contribution of something (crit rate,
     * MP per tick, mitigation, etc) that is given by
     * having a certain amount of stat above the stat base
     */
    const extra = function (currentValue) {
        const delta = currentValue.minus(statBase);
        return deltaRate.times(delta).dividedBy(levelMod).floor();
    };

    this.derivedValues = function () {

        // derivedValueDefns is a list, and later derived
        // values in that list can reference earlier
        // derived values through this array. I call these
        // 'intermediates'.
        //
        // for example: Expected Damage in Crit is
        // `rate * bonus`, where rate and bonus are
        // themselves derived from the crit stat itself
        const intermediates = [];

        return derivedValueDefns.map((v) => {
            const realValue = v.calcFn(this.currentValue,
                extra(this.currentValue), intermediates);

            intermediates[v.name] = realValue;

            // don't calculate breakpoints if the user has
            // entered a value below the minimum stat base,
            // as the breakpoints make no sense if so
            const aboveMinimum =
                this.currentValue.greaterThanOrEqualTo(statBase);

            // our breakpoint calculation is naive:
            // increment or decrement the stat until the
            // derived value has changed, effectively.
            //
            // we do have an upper limit on the distance
            // we'll search, but in practice this shouldn't
            // be hit unless there is a bug in the code.
            if (v.hasBreakpoints && aboveMinimum) {
                let lesserBreakpoint = this.currentValue;
                let breaker = 0;
                while (v.calcFn(lesserBreakpoint,
                    extra(lesserBreakpoint)) >= realValue
                    && breaker++ < 1e4)
                {
                    lesserBreakpoint =
                        lesserBreakpoint.plus(v.lesserBreakpointDirection);
                }

                let greaterBreakpoint = this.currentValue;
                breaker = 0;
                while (v.calcFn(greaterBreakpoint,
                    extra(greaterBreakpoint)) <= realValue
                    && breaker++ < 1e4)
                {
                    greaterBreakpoint =
                        greaterBreakpoint.plus(v.greaterBreakpointDirection);
                }

                return { name: v.displayName,
                    value: realValue,
                    hasBreakpoints: true,
                    isPercent: v.isPercent,
                    lesserBreakpoint, greaterBreakpoint };
            } else {
                return { name: v.displayName,
                    value: realValue,
                    isPercent: v.isPercent,
                    hasBreakpoints: false };
            }
        });
    };
}

/*
 * Formats a decimal as +Y or -Y.
 */
function formatDecimal(x) {
    return x.greaterThanOrEqualTo(0) ? `+${x}` : `${x}`;
}

/*
 * StatBlock is the Mithril component that actually
 * displays the stat, an input to change it, a couple
 * buttons to increment/decrement, and the derived
 * values of that stat.
 */
function StatBlock(initialVnode) {
    // each stat block references one stat
    let stat;

    return {
        oninit: function (vnode) {
            stat = vnode.attrs.stat;
        },

        view: function (vnode) {
            return m('p', [
                m('h2', `${stat.name}`),

                m('input[type=text]', {
                    oninput: function () {
                        const input = parseInt(this.value);

                        // ignore invalid values (set to 0)
                        stat.currentValue = new Decimal(
                            Number.isNaN(input) ? '0' : input
                        );
                    },
                    value: stat.currentValue
                }),

                // decrement/increment buttons aren't exactly
                // the most useful for the user, but they're nice
                // for testing purposes, so eh
                m('button', {
                    onclick: function () {
                        stat.currentValue = stat.currentValue.minus(1);
                    }
                }, '-'),

                m('button', {
                    onclick: function () {
                        stat.currentValue = stat.currentValue.plus(1);
                    }
                }, '+'),

                m('ul', [
                ...stat.derivedValues()
                    .map((v) => {
                        // display stats as a nice percent if possible
                        let valString;
                        if (v.isPercent) {
                            const percent = v.value.times(100) + '%';
                            valString = `${percent} (${v.value})`;
                        } else {
                            valString = v.value;
                        }

                        if (v.hasBreakpoints) {
                            const lowerDiff =
                                v.lesserBreakpoint.minus(stat.currentValue);
                            const upperDiff =
                                v.greaterBreakpoint.minus(stat.currentValue);

                            return m('li',
                                `${v.name} = ${valString}
                                    —
                                    next lowest: ${v.lesserBreakpoint}
                                    (${formatDecimal(lowerDiff)}),
                                     next highest: ${v.greaterBreakpoint}
                                    (${formatDecimal(upperDiff)})`);
                        } else {
                            return m('li',
                                `${v.name} = ${valString}`);
                        }
                    })
                ]),
            ]);
        }
    }
}

/*
 * The StatList has the actual stat and derived value definitions.
 */
function StatList() {
    const stats = [
        new Stat('Critical Hit', new Decimal(380), new Decimal(200), [
            new DerivedValue('rate', 'Crit Rate', (s, extra) => {
                return (extra.plus(50)).dividedBy(1000);
            }),

            new DerivedValue('bonus', 'Bonus Dmg', (s, extra) => {
                return (extra.plus(400)).dividedBy(1000);
            }),

            new NoBreakpointDerivedValue('edmg', 'Expected Dmg',
                (s, e, inter) =>
            {
                return new Decimal(1).plus(
                    inter.rate.times(inter.bonus)
                );
            }),
        ]),

        new Stat('Direct Hit', new Decimal(380), new Decimal(550), [
            new DerivedValue('rate', 'DH Hit', (s, extra) => {
                return extra.dividedBy(1000);
            }),

            new NoBreakpointDerivedValue('bonus', 'Bonus Dmg', () => {
                return new Decimal(0.25);
            }),

            new NoBreakpointDerivedValue('edmg', 'Expected Dmg',
                (s, e, inter) =>
            {
                return new Decimal(1).plus(
                    inter.rate.times(inter.bonus)
                );
            }),
        ]),

        new Stat('Determination', new Decimal(340), new Decimal(130), [
            new DerivedValue('damage mult',
                'Damage Multiplier', (s, extra) =>
            {
                return (extra.plus(1000)).dividedBy(1000);
            }),
        ]),

        new Stat('Spell/Skill Speed', new Decimal(380), new Decimal(130), [
            new DerivedValue('mult', 'DoT Scalar', (s, extra) => {
                return (extra.plus(1000)).dividedBy(1000);
            }),

            new SpeedDerivedValue('1.5s', 1500),
            new SpeedDerivedValue('2.0s', 2000),
            new SpeedDerivedValue('2.5s', 2500),
            new SpeedDerivedValue('2.8s', 2800),
            new SpeedDerivedValue('3.0s', 3000),
            new SpeedDerivedValue('3.5s', 3500),
            new SpeedDerivedValue('4.0s', 4000),
        ]),

        new Stat('Tenacity', new Decimal(380), new Decimal(100), [
            new DerivedValue('mult', 'Damage Multiplier', (s, extra) => {
                return (extra.plus(1000)).dividedBy(1000);
            }),

            new InvertedDerivedValue('mit', 'Mitigation%', (s, extra) => {
                return new Decimal(1000)
                    .minus(extra)
                    .dividedBy(1000);
            }),
        ]),

        new Stat('Piety', new Decimal(340), new Decimal(150), [
            new DerivedValue('mp', 'Additional MP per Tick', (s, extra) => {
                return extra;
            }).isntPercent(),
        ]),

        new Stat('Defense', new Decimal(0), new Decimal(15), [
            new DerivedValue('mit', 'Mitigation%', (s, extra) => {
                return extra.dividedBy(100);
            }),
        ]),

    ];

    return {
        view: function () {
            return m('body', [
                m('h1', 'FFXIV Stat Calculator'),
                m('p', m.trust(`Below you can enter FFXIV stats to see their
                        corresponding values at level 80. These calculations were taken from the
                        <a href='http://theoryjerks.akhmorning.com/'>Theoryjerks</a>
                        website, and all credit goes to them.`)),
                m('p', m.trust(`View source code and suggest edits
                        <a href='https://github.com/Drovolon/ffxiv-stat-calculator'>on GitHub</a>.`)),
                ...stats.map((s) => m(StatBlock, { stat: s }))
            ])
        }
    };
}

const root = document.body;
m.mount(root, StatList);

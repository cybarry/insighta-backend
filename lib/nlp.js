// Natural Language Query Parser
// Rule-based only — no AI/LLM usage
//
// Supported keywords and mappings:
//   Gender:    "male(s)", "female(s)", "men", "women", "boys", "girls", "man", "woman"
//   Age group: "child/children", "teenager(s)/teen(s)", "adult(s)", "senior(s)/elderly/old"
//   Young:     "young" → min_age=16, max_age=24  (special rule, not a stored age_group)
//   Age:       "above/over/older than X" → min_age=X
//              "below/under/younger than X" → max_age=X
//              "between X and Y" → min_age=X, max_age=Y
//              "aged X" → min_age=X, max_age=X
//   Country:   "from [country name]" or "in [country name]" → country_id

// Comprehensive map of country names (lowercase) → ISO 3166-1 alpha-2 codes
const countryMap = {
    "nigeria": "NG",
    "kenya": "KE",
    "angola": "AO",
    "benin": "BJ",
    "ghana": "GH",
    "south africa": "ZA",
    "tanzania": "TZ",
    "uganda": "UG",
    "ethiopia": "ET",
    "cameroon": "CM",
    "senegal": "SN",
    "ivory coast": "CI",
    "côte d'ivoire": "CI",
    "cote d'ivoire": "CI",
    "mali": "ML",
    "niger": "NE",
    "burkina faso": "BF",
    "madagascar": "MG",
    "malawi": "MW",
    "zambia": "ZM",
    "zimbabwe": "ZW",
    "rwanda": "RW",
    "togo": "TG",
    "sierra leone": "SL",
    "liberia": "LR",
    "mozambique": "MZ",
    "democratic republic of the congo": "CD",
    "dr congo": "CD",
    "drc": "CD",
    "congo": "CD",
    "egypt": "EG",
    "morocco": "MA",
    "tunisia": "TN",
    "algeria": "DZ",
    "sudan": "SD",
    "somalia": "SO",
    "chad": "TD",
    "guinea": "GN",
    "burundi": "BI",
    "eritrea": "ER",
    "namibia": "NA",
    "botswana": "BW",
    "lesotho": "LS",
    "gambia": "GM",
    "gabon": "GA",
    "mauritius": "MU",
    "eswatini": "SZ",
    "swaziland": "SZ",
    "comoros": "KM",
    "cape verde": "CV",
    "djibouti": "DJ",
    "equatorial guinea": "GQ",
    "guinea-bissau": "GW",
    "libya": "LY",
    "mauritania": "MR",
    "sao tome and principe": "ST",
    "seychelles": "SC",
    "central african republic": "CF",
    "south sudan": "SS",
    "republic of the congo": "CG",
};

export function parseQuery(q) {
    if (!q || typeof q !== 'string') return null;

    const filters = {};
    const query = q.toLowerCase().trim();

    // 1. Gender Detection
    //    Check female FIRST so "male and female" or "females" is handled properly.
    //    But also handle "male and female" as no gender filter (both genders).
    const hasMale = /\b(males?|men|boys?|man)\b/.test(query);
    const hasFemale = /\b(females?|women|girls?|woman)\b/.test(query);

    if (hasMale && hasFemale) {
        // Both genders mentioned — don't filter by gender (return all)
    } else if (hasFemale) {
        filters.gender = 'female';
    } else if (hasMale) {
        filters.gender = 'male';
    }

    // 2. Age Group Detection (stored values: child, teenager, adult, senior)
    //    Also handle plurals and synonyms
    if (/\b(child|children)\b/.test(query)) filters.age_group = 'child';
    if (/\b(teenagers?|teens?)\b/.test(query)) filters.age_group = 'teenager';
    if (/\b(adults?)\b/.test(query)) filters.age_group = 'adult';
    if (/\b(seniors?|elderly|old people|old men|old women)\b/.test(query)) filters.age_group = 'senior';

    // 3. "Young" Logic — Special rule: 16-24. NOT a stored age group.
    if (/\byoung\b/.test(query)) {
        filters.min_age = 16;
        filters.max_age = 24;
    }

    // 4. Age range patterns
    // "above X" / "over X" / "older than X"
    const aboveMatch = query.match(/\b(?:above|over|older than)\s+(\d+)\b/);
    if (aboveMatch) {
        filters.min_age = parseInt(aboveMatch[1]);
    }

    // "below X" / "under X" / "younger than X"
    const belowMatch = query.match(/\b(?:below|under|younger than)\s+(\d+)\b/);
    if (belowMatch) {
        filters.max_age = parseInt(belowMatch[1]);
    }

    // "between X and Y"
    const betweenMatch = query.match(/\bbetween\s+(\d+)\s+and\s+(\d+)\b/);
    if (betweenMatch) {
        filters.min_age = parseInt(betweenMatch[1]);
        filters.max_age = parseInt(betweenMatch[2]);
    }

    // "aged X"
    const agedMatch = query.match(/\baged\s+(\d+)\b/);
    if (agedMatch) {
        filters.min_age = parseInt(agedMatch[1]);
        filters.max_age = parseInt(agedMatch[1]);
    }

    // 5. Country Detection — "from [country]" or "in [country]"
    const countryMatch = query.match(/\b(?:from|in)\s+([a-zA-ZÀ-ÿ\s'-]+)/);
    if (countryMatch) {
        let countryName = countryMatch[1].trim();
        // Remove trailing common words that aren't part of the country name
        countryName = countryName.replace(/\s+(who|that|and|with|above|below|over|under|aged|between|are).*$/i, '');
        countryName = countryName.trim();

        if (countryMap[countryName]) {
            filters.country_id = countryMap[countryName];
        } else {
            // Try partial match (e.g., "from nigeria" at end of string)
            for (const [name, code] of Object.entries(countryMap)) {
                if (countryName.startsWith(name) || name.startsWith(countryName)) {
                    filters.country_id = code;
                    break;
                }
            }
        }
    }

    // If no filters were extracted, the query is uninterpretable
    if (Object.keys(filters).length === 0) return null;

    return filters;
}
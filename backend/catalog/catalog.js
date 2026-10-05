// Product categories, profile photo slots and scenes. Edit and redeploy the backend to add
// categories - the extension downloads this at runtime (GET /api/config), no extension rebuild needed.
export default {
  "version": 1,
  "photoSlots": {
    "full": {
      "label": "Full body (front)",
      "required": true,
      "description": "Your main reference photo. Used for dresses, outfits, jackets and as a fallback for everything.",
      "guidance": [
        "Stand straight facing the camera, arms slightly away from your body.",
        "Whole body visible from head to feet with a little space above and below.",
        "Wear fitted, plain clothing (e.g. a plain T-shirt and leggings/jeans).",
        "Even, bright light - avoid strong backlight or harsh shadows.",
        "Plain background if possible; ask someone else to take it at chest height."
      ]
    },
    "upper": {
      "label": "Upper body",
      "required": false,
      "description": "Waist up. Gives the best detail for T-shirts, shirts, tops and jackets.",
      "guidance": [
        "Frame from the top of your head to just below your waist.",
        "Face the camera, shoulders relaxed, arms at your sides.",
        "Wear a plain, fitted top without logos or prints."
      ]
    },
    "lower": {
      "label": "Legs / lower body",
      "required": false,
      "description": "Waist down. Improves trousers, jeans, shorts and skirts.",
      "guidance": [
        "Frame from your waist to your feet.",
        "Stand straight with feet hip-width apart.",
        "Wear fitted shorts or leggings so your leg shape is clear."
      ]
    },
    "feet": {
      "label": "Feet / shoes",
      "required": false,
      "description": "Used for shoes and socks.",
      "guidance": [
        "Photograph both feet from a slight front angle (about 45 degrees), camera at knee height.",
        "Bare feet or plain socks; include your ankles and lower calves.",
        "Stand on a plain floor with good light."
      ]
    },
    "face": {
      "label": "Face close-up",
      "required": false,
      "description": "Helps the AI keep your identity accurate. Used for necklaces, earrings, glasses and hats.",
      "guidance": [
        "Head and shoulders, looking straight at the camera.",
        "Neutral expression, hair away from your neck if you want to try necklaces.",
        "Soft, even light on your face - no sunglasses or hats."
      ]
    },
    "hands": {
      "label": "Hands / wrists",
      "required": false,
      "description": "Used for rings, bracelets and watches.",
      "guidance": [
        "Both hands, palms down, fingers slightly apart.",
        "Include your wrists and part of your forearms.",
        "Plain background, no jewellery."
      ]
    }
  },
  "categories": {
    "tshirt": {
      "label": "T-shirts & tops",
      "verb": "wearing",
      "photos": ["upper", "full"],
      "keywords": ["t-shirt", "tshirt", "tee", "tees", "top", "tops", "tank", "camisole", "cami", "polo", "crop top", "blouse", "sweatshirt", "hoodie", "jumper", "sweater", "pullover", "cardigan", "knit"],
      "placement": "Dress the person in this top on their upper body. Keep the garment's exact cut, sleeve length, neckline and length. The fabric must drape naturally over the shoulders, chest and torso with realistic folds and shadows.",
      "defaultScene": "casual"
    },
    "shirt": {
      "label": "Shirts",
      "verb": "wearing",
      "photos": ["upper", "full"],
      "keywords": ["shirt", "shirts", "button-down", "button down", "oxford", "flannel", "overshirt", "dress shirt", "linen shirt"],
      "placement": "Dress the person in this shirt on their upper body. Preserve the collar, buttons, placket, pockets, cuffs and sleeve length exactly. Show natural tailoring and fabric folds.",
      "defaultScene": "smart"
    },
    "dress": {
      "label": "Dresses",
      "verb": "wearing",
      "photos": ["full"],
      "keywords": ["dress", "dresses", "gown", "maxi", "midi", "mini dress", "sundress", "jumpsuit", "playsuit", "romper", "kaftan", "saree", "sari", "skirt"],
      "placement": "Dress the person in this garment over their full body. Keep the exact silhouette, neckline, waistline, hem length and skirt volume. The fabric must fall naturally with gravity and follow the body's shape.",
      "defaultScene": "elegant"
    },
    "jacket": {
      "label": "Jackets & coats",
      "verb": "wearing",
      "photos": ["upper", "full"],
      "keywords": ["jacket", "jackets", "coat", "coats", "blazer", "parka", "puffer", "bomber", "windbreaker", "gilet", "vest", "trench", "anorak", "outerwear", "fleece", "shacket"],
      "placement": "Put this jacket/coat on the person as an outer layer over their current top. Preserve collar/lapels, zips, buttons, pockets, length and texture. Show realistic structure and volume of the outerwear.",
      "defaultScene": "outdoor"
    },
    "pants": {
      "label": "Pants & trousers",
      "verb": "wearing",
      "photos": ["full", "lower"],
      "keywords": ["pants", "trousers", "jeans", "denim", "chinos", "joggers", "leggings", "shorts", "cargo", "sweatpants", "slacks", "culottes"],
      "placement": "Dress the person in these trousers on their lower body, from the waist to the ankles (or to the correct length for shorts). Preserve the exact fit (skinny/straight/wide), rise, wash/colour, pockets and hem.",
      "defaultScene": "casual"
    },
    "shoes": {
      "label": "Shoes",
      "verb": "wearing",
      "photos": ["feet", "full"],
      "keywords": ["shoe", "shoes", "sneaker", "sneakers", "trainer", "trainers", "boot", "boots", "heel", "heels", "sandal", "sandals", "loafer", "loafers", "slipper", "slippers", "flip flop", "flip-flops", "pumps", "mules", "footwear", "oxfords", "espadrille", "clogs"],
      "placement": "Put these shoes on both of the person's feet. Show correct left/right shoes, realistic perspective, scale relative to the body, contact shadows with the ground, and preserve the sole, laces, logos and colourway exactly.",
      "defaultScene": "street"
    },
    "necklace": {
      "label": "Necklaces",
      "verb": "wearing",
      "photos": ["face", "upper", "full"],
      "keywords": ["necklace", "necklaces", "pendant", "chain", "choker", "locket", "lariat", "mangalsutra"],
      "placement": "Place this necklace around the person's neck, resting naturally on the collarbones/chest with correct chain length and gravity. Preserve the exact metal colour, gemstones, pendant shape and size relative to the body. Use a close-up or head-and-shoulders framing.",
      "defaultScene": "portrait",
      "framing": "head-and-shoulders close-up"
    },
    "jewellery": {
      "label": "Jewellery (earrings, rings, bracelets)",
      "verb": "wearing",
      "photos": ["face", "hands", "upper"],
      "keywords": ["jewellery", "jewelry", "earring", "earrings", "studs", "hoops", "ring", "rings", "bracelet", "bracelets", "bangle", "bangles", "anklet", "brooch", "cuff"],
      "placement": "Put this jewellery on the correct body part (earrings on the ears, rings on a finger, bracelets/bangles on the wrist). Preserve the exact metal, stones, shape and realistic small scale. Frame the shot so the jewellery is clearly visible.",
      "defaultScene": "portrait",
      "framing": "close-up of the relevant body part with the face visible where natural"
    },
    "watch": {
      "label": "Watches",
      "verb": "wearing",
      "photos": ["hands", "upper"],
      "keywords": ["watch", "watches", "smartwatch", "wristwatch", "chronograph"],
      "placement": "Put this watch on the person's left wrist, with the dial facing the camera. Preserve the dial, hands, case, strap material and colour exactly at a realistic size.",
      "defaultScene": "smart",
      "framing": "medium close-up including the wrist and face"
    },
    "eyewear": {
      "label": "Glasses & sunglasses",
      "verb": "wearing",
      "photos": ["face", "upper"],
      "keywords": ["sunglasses", "glasses", "eyewear", "spectacles", "frames", "aviator", "shades"],
      "placement": "Put these glasses on the person's face, sitting correctly on the nose bridge and ears, aligned with the eyes and matching head angle. Preserve frame shape, colour and lens tint exactly.",
      "defaultScene": "street",
      "framing": "head-and-shoulders portrait"
    },
    "hat": {
      "label": "Hats & caps",
      "verb": "wearing",
      "photos": ["face", "upper", "full"],
      "keywords": ["hat", "hats", "cap", "caps", "beanie", "beret", "fedora", "bucket hat", "snapback", "headband"],
      "placement": "Put this hat on the person's head at a natural angle, sized correctly to the head, with hair adjusted naturally. Preserve the shape, colour, logos and embroidery exactly.",
      "defaultScene": "street",
      "framing": "head-and-shoulders or upper-body portrait"
    },
    "bag": {
      "label": "Bags",
      "verb": "carrying",
      "photos": ["full", "upper"],
      "keywords": ["bag", "bags", "handbag", "tote", "backpack", "clutch", "purse", "satchel", "crossbody", "shoulder bag", "duffel", "wallet"],
      "placement": "Have the person carry this bag naturally (on the shoulder, crossbody, in hand or on the back as appropriate for the bag type). Preserve its exact shape, size, hardware, logo and colour.",
      "defaultScene": "street"
    },
    "accessories": {
      "label": "Other accessories",
      "verb": "wearing",
      "photos": ["full", "upper", "face"],
      "keywords": ["accessory", "accessories", "scarf", "scarves", "belt", "belts", "tie", "bow tie", "gloves", "socks", "hair clip", "suspenders"],
      "placement": "Add this accessory to the person in the position where it is normally worn. Preserve its exact appearance, size, colour and material.",
      "defaultScene": "casual"
    }
  },
  "scenes": {
    "studio": {
      "label": "Studio",
      "prompt": "a clean, professional e-commerce photo studio with a seamless light-grey backdrop and soft, even lighting"
    },
    "casual": {
      "label": "Everyday street",
      "prompt": "a bright, relaxed urban street or café terrace in natural daylight",
      "keywords": ["casual", "everyday", "basic", "essential", "relaxed", "graphic"]
    },
    "street": {
      "label": "City street",
      "prompt": "a stylish city sidewalk with modern architecture in soft afternoon light",
      "keywords": ["street", "urban", "sneaker", "skate", "streetwear"]
    },
    "beach": {
      "label": "Beach",
      "prompt": "a sunny tropical beach with turquoise water, soft sand and warm natural sunlight",
      "keywords": ["beach", "swim", "swimwear", "bikini", "hawaiian", "aloha", "tropical", "resort", "surf", "board shorts", "boardshorts", "flip flop", "flip-flop", "sandal", "linen", "palm", "summer", "vacation", "holiday"]
    },
    "elegant": {
      "label": "Elegant evening",
      "prompt": "an elegant evening venue with warm ambient lighting, such as a stylish restaurant terrace or gallery",
      "keywords": ["evening", "cocktail", "party", "gown", "formal", "satin", "silk", "sequin", "wedding", "bridal", "prom", "gala", "occasion"]
    },
    "smart": {
      "label": "Smart / office",
      "prompt": "a modern, bright office lobby or upscale city setting",
      "keywords": ["office", "work", "business", "suit", "blazer", "oxford", "formal shirt", "tailored", "smart"]
    },
    "outdoor": {
      "label": "Outdoors",
      "prompt": "a scenic outdoor trail with trees and mountains in soft natural light",
      "keywords": ["hiking", "trail", "outdoor", "waterproof", "rain", "parka", "fleece", "trekking", "camping", "windproof", "anorak"]
    },
    "winter": {
      "label": "Winter",
      "prompt": "a snowy winter city street with soft overcast light",
      "keywords": ["winter", "wool", "puffer", "down jacket", "thermal", "snow", "ski", "beanie", "knit", "cashmere", "shearling"]
    },
    "sport": {
      "label": "Sport",
      "prompt": "a modern gym or outdoor running track in bright light",
      "keywords": ["running", "gym", "training", "workout", "athletic", "sport", "sports", "yoga", "performance", "tennis", "football", "jersey", "activewear", "dri-fit"]
    },
    "portrait": {
      "label": "Portrait close-up",
      "prompt": "a softly lit, elegant portrait setting with a gently blurred neutral background that keeps focus on the person and the item",
      "keywords": ["diamond", "gold", "silver", "pearl", "gemstone", "bridal jewellery", "fine jewellery"]
    }
  }
};

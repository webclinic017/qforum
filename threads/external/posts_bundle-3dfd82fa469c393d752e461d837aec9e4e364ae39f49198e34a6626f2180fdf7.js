var Markdown;

if (typeof exports === "object" && typeof require === "function") // we're in a CommonJS (e.g. Node.js) module
    Markdown = exports;
else
    Markdown = {};
    
// The following text is included for historical reasons, but should
// be taken with a pinch of salt; it's not all true anymore.

//
// Wherever possible, Showdown is a straight, line-by-line port
// of the Perl version of Markdown.
//
// This is not a normal parser design; it's basically just a
// series of string substitutions.  It's hard to read and
// maintain this way,  but keeping Showdown close to the original
// design makes it easier to port new features.
//
// More importantly, Showdown behaves like markdown.pl in most
// edge cases.  So web applications can do client-side preview
// in Javascript, and then build identical HTML on the server.
//
// This port needs the new RegExp functionality of ECMA 262,
// 3rd Edition (i.e. Javascript 1.5).  Most modern web browsers
// should do fine.  Even with the new regular expression features,
// We do a lot of work to emulate Perl's regex functionality.
// The tricky changes in this file mostly have the "attacklab:"
// label.  Major or self-explanatory changes don't.
//
// Smart diff tools like Araxis Merge will be able to match up
// this file with markdown.pl in a useful way.  A little tweaking
// helps: in a copy of markdown.pl, replace "#" with "//" and
// replace "$text" with "text".  Be sure to ignore whitespace
// and line endings.
//


//
// Usage:
//
//   var text = "Markdown *rocks*.";
//
//   var converter = new Markdown.Converter();
//   var html = converter.makeHtml(text);
//
//   alert(html);
//
// Note: move the sample code to the bottom of this
// file before uncommenting it.
//

(function () {

    function identity(x) { return x; }
    function returnFalse(x) { return false; }

    function HookCollection() { }

    HookCollection.prototype = {

        chain: function (hookname, func) {
            var original = this[hookname];
            if (!original)
                throw new Error("unknown hook " + hookname);

            if (original === identity)
                this[hookname] = func;
            else
                this[hookname] = function (x) { return func(original(x)); }
        },
        set: function (hookname, func) {
            if (!this[hookname])
                throw new Error("unknown hook " + hookname);
            this[hookname] = func;
        },
        addNoop: function (hookname) {
            this[hookname] = identity;
        },
        addFalse: function (hookname) {
            this[hookname] = returnFalse;
        }
    };

    Markdown.HookCollection = HookCollection;

    // g_urls and g_titles allow arbitrary user-entered strings as keys. This
    // caused an exception (and hence stopped the rendering) when the user entered
    // e.g. [push] or [__proto__]. Adding a prefix to the actual key prevents this
    // (since no builtin property starts with "s_"). See
    // http://meta.stackoverflow.com/questions/64655/strange-wmd-bug
    // (granted, switching from Array() to Object() alone would have left only __proto__
    // to be a problem)
    function SaveHash() { }
    SaveHash.prototype = {
        set: function (key, value) {
            this["s_" + key] = value;
        },
        get: function (key) {
            return this["s_" + key];
        }
    };

    Markdown.Converter = function () {
        var pluginHooks = this.hooks = new HookCollection();
        pluginHooks.addNoop("plainLinkText");  // given a URL that was encountered by itself (without markup), should return the link text that's to be given to this link
        pluginHooks.addNoop("preConversion");  // called with the orignal text as given to makeHtml. The result of this plugin hook is the actual markdown source that will be cooked
        pluginHooks.addNoop("postConversion"); // called with the final cooked HTML code. The result of this plugin hook is the actual output of makeHtml

        //
        // Private state of the converter instance:
        //

        // Global hashes, used by various utility routines
        var g_urls;
        var g_titles;
        var g_html_blocks;

        // Used to track when we're inside an ordered or unordered list
        // (see _ProcessListItems() for details):
        var g_list_level;

        this.makeHtml = function (text) {

            //
            // Main function. The order in which other subs are called here is
            // essential. Link and image substitutions need to happen before
            // _EscapeSpecialCharsWithinTagAttributes(), so that any *'s or _'s in the <a>
            // and <img> tags get encoded.
            //

            // This will only happen if makeHtml on the same converter instance is called from a plugin hook.
            // Don't do that.
            if (g_urls)
                throw new Error("Recursive call to converter.makeHtml");
        
            // Create the private state objects.
            g_urls = new SaveHash();
            g_titles = new SaveHash();
            g_html_blocks = [];
            g_list_level = 0;

            text = pluginHooks.preConversion(text);

            // attacklab: Replace ~ with ~T
            // This lets us use tilde as an escape char to avoid md5 hashes
            // The choice of character is arbitray; anything that isn't
            // magic in Markdown will work.
            text = text.replace(/~/g, "~T");

            // attacklab: Replace $ with ~D
            // RegExp interprets $ as a special character
            // when it's in a replacement string
            text = text.replace(/\$/g, "~D");

            // Standardize line endings
            text = text.replace(/\r\n/g, "\n"); // DOS to Unix
            text = text.replace(/\r/g, "\n"); // Mac to Unix

            // Make sure text begins and ends with a couple of newlines:
            text = "\n\n" + text + "\n\n";

            // Convert all tabs to spaces.
            text = _Detab(text);

            // Strip any lines consisting only of spaces and tabs.
            // This makes subsequent regexen easier to write, because we can
            // match consecutive blank lines with /\n+/ instead of something
            // contorted like /[ \t]*\n+/ .
            text = text.replace(/^[ \t]+$/mg, "");

            // Turn block-level HTML blocks into hash entries
            text = _HashHTMLBlocks(text);

            // Strip link definitions, store in hashes.
            text = _StripLinkDefinitions(text);

            text = _RunBlockGamut(text);

            text = _UnescapeSpecialChars(text);

            // attacklab: Restore dollar signs
            text = text.replace(/~D/g, "$$");

            // attacklab: Restore tildes
            text = text.replace(/~T/g, "~");

            text = pluginHooks.postConversion(text);

            g_html_blocks = g_titles = g_urls = null;

            return text;
        };

        function _StripLinkDefinitions(text) {
            //
            // Strips link definitions from text, stores the URLs and titles in
            // hash references.
            //

            // Link defs are in the form: ^[id]: url "optional title"

            /*
            text = text.replace(/
                ^[ ]{0,3}\[(.+)\]:  // id = $1  attacklab: g_tab_width - 1
                [ \t]*
                \n?                 // maybe *one* newline
                [ \t]*
                <?(\S+?)>?          // url = $2
                (?=\s|$)            // lookahead for whitespace instead of the lookbehind removed below
                [ \t]*
                \n?                 // maybe one newline
                [ \t]*
                (                   // (potential) title = $3
                    (\n*)           // any lines skipped = $4 attacklab: lookbehind removed
                    [ \t]+
                    ["(]
                    (.+?)           // title = $5
                    [")]
                    [ \t]*
                )?                  // title is optional
                (?:\n+|$)
            /gm, function(){...});
            */

            text = text.replace(/^[ ]{0,3}\[(.+)\]:[ \t]*\n?[ \t]*<?(\S+?)>?(?=\s|$)[ \t]*\n?[ \t]*((\n*)["(](.+?)[")][ \t]*)?(?:\n+)/gm,
                function (wholeMatch, m1, m2, m3, m4, m5) {
                    m1 = m1.toLowerCase();
                    g_urls.set(m1, _EncodeAmpsAndAngles(m2));  // Link IDs are case-insensitive
                    if (m4) {
                        // Oops, found blank lines, so it's not a title.
                        // Put back the parenthetical statement we stole.
                        return m3;
                    } else if (m5) {
                        g_titles.set(m1, m5.replace(/"/g, "&quot;"));
                    }

                    // Completely remove the definition from the text
                    return "";
                }
            );

            return text;
        }

        function _HashHTMLBlocks(text) {

            // Hashify HTML blocks:
            // We only want to do this for block-level HTML tags, such as headers,
            // lists, and tables. That's because we still want to wrap <p>s around
            // "paragraphs" that are wrapped in non-block-level tags, such as anchors,
            // phrase emphasis, and spans. The list of tags we're looking for is
            // hard-coded:
            var block_tags_a = "p|div|h[1-6]|blockquote|pre|table|dl|ol|ul|script|noscript|form|fieldset|iframe|math|ins|del"
            var block_tags_b = "p|div|h[1-6]|blockquote|pre|table|dl|ol|ul|script|noscript|form|fieldset|iframe|math"

            // First, look for nested blocks, e.g.:
            //   <div>
            //     <div>
            //     tags for inner block must be indented.
            //     </div>
            //   </div>
            //
            // The outermost tags must start at the left margin for this to match, and
            // the inner nested divs must be indented.
            // We need to do this before the next, more liberal match, because the next
            // match will start at the first `<div>` and stop at the first `</div>`.

            // attacklab: This regex can be expensive when it fails.

            /*
            text = text.replace(/
                (                       // save in $1
                    ^                   // start of line  (with /m)
                    <($block_tags_a)    // start tag = $2
                    \b                  // word break
                                        // attacklab: hack around khtml/pcre bug...
                    [^\r]*?\n           // any number of lines, minimally matching
                    </\2>               // the matching end tag
                    [ \t]*              // trailing spaces/tabs
                    (?=\n+)             // followed by a newline
                )                       // attacklab: there are sentinel newlines at end of document
            /gm,function(){...}};
            */
            text = text.replace(/^(<(p|div|h[1-6]|blockquote|pre|table|dl|ol|ul|script|noscript|form|fieldset|iframe|math|ins|del)\b[^\r]*?\n<\/\2>[ \t]*(?=\n+))/gm, hashElement);

            //
            // Now match more liberally, simply from `\n<tag>` to `</tag>\n`
            //

            /*
            text = text.replace(/
                (                       // save in $1
                    ^                   // start of line  (with /m)
                    <($block_tags_b)    // start tag = $2
                    \b                  // word break
                                        // attacklab: hack around khtml/pcre bug...
                    [^\r]*?             // any number of lines, minimally matching
                    .*</\2>             // the matching end tag
                    [ \t]*              // trailing spaces/tabs
                    (?=\n+)             // followed by a newline
                )                       // attacklab: there are sentinel newlines at end of document
            /gm,function(){...}};
            */
            text = text.replace(/^(<(p|div|h[1-6]|blockquote|pre|table|dl|ol|ul|script|noscript|form|fieldset|iframe|math)\b[^\r]*?.*<\/\2>[ \t]*(?=\n+)\n)/gm, hashElement);

            // Special case just for <hr />. It was easier to make a special case than
            // to make the other regex more complicated.  

            /*
            text = text.replace(/
                \n                  // Starting after a blank line
                [ ]{0,3}
                (                   // save in $1
                    (<(hr)          // start tag = $2
                        \b          // word break
                        ([^<>])*?
                    \/?>)           // the matching end tag
                    [ \t]*
                    (?=\n{2,})      // followed by a blank line
                )
            /g,hashElement);
            */
            text = text.replace(/\n[ ]{0,3}((<(hr)\b([^<>])*?\/?>)[ \t]*(?=\n{2,}))/g, hashElement);

            // Special case for standalone HTML comments:

            /*
            text = text.replace(/
                \n\n                                            // Starting after a blank line
                [ ]{0,3}                                        // attacklab: g_tab_width - 1
                (                                               // save in $1
                    <!
                    (--(?:|(?:[^>-]|-[^>])(?:[^-]|-[^-])*)--)   // see http://www.w3.org/TR/html-markup/syntax.html#comments and http://meta.stackoverflow.com/q/95256
                    >
                    [ \t]*
                    (?=\n{2,})                                  // followed by a blank line
                )
            /g,hashElement);
            */
            text = text.replace(/\n\n[ ]{0,3}(<!(--(?:|(?:[^>-]|-[^>])(?:[^-]|-[^-])*)--)>[ \t]*(?=\n{2,}))/g, hashElement);

            // PHP and ASP-style processor instructions (<?...?> and <%...%>)

            /*
            text = text.replace(/
                (?:
                    \n\n            // Starting after a blank line
                )
                (                   // save in $1
                    [ ]{0,3}        // attacklab: g_tab_width - 1
                    (?:
                        <([?%])     // $2
                        [^\r]*?
                        \2>
                    )
                    [ \t]*
                    (?=\n{2,})      // followed by a blank line
                )
            /g,hashElement);
            */
            text = text.replace(/(?:\n\n)([ ]{0,3}(?:<([?%])[^\r]*?\2>)[ \t]*(?=\n{2,}))/g, hashElement);

            return text;
        }

        function hashElement(wholeMatch, m1) {
            var blockText = m1;

            // Undo double lines
            blockText = blockText.replace(/^\n+/, "");

            // strip trailing blank lines
            blockText = blockText.replace(/\n+$/g, "");

            // Replace the element text with a marker ("~KxK" where x is its key)
            blockText = "\n\n~K" + (g_html_blocks.push(blockText) - 1) + "K\n\n";

            return blockText;
        }

        function _RunBlockGamut(text, doNotUnhash) {
            //
            // These are all the transformations that form block-level
            // tags like paragraphs, headers, and list items.
            //
            text = _DoHeaders(text);

            // Do Horizontal Rules:
            var replacement = "<hr />\n";
            text = text.replace(/^[ ]{0,2}([ ]?\*[ ]?){3,}[ \t]*$/gm, replacement);
            text = text.replace(/^[ ]{0,2}([ ]?-[ ]?){3,}[ \t]*$/gm, replacement);
            text = text.replace(/^[ ]{0,2}([ ]?_[ ]?){3,}[ \t]*$/gm, replacement);

            text = _DoLists(text);
            text = _DoCodeBlocks(text);
            text = _DoBlockQuotes(text);

            // We already ran _HashHTMLBlocks() before, in Markdown(), but that
            // was to escape raw HTML in the original Markdown source. This time,
            // we're escaping the markup we've just created, so that we don't wrap
            // <p> tags around block-level tags.
            text = _HashHTMLBlocks(text);
            text = _FormParagraphs(text, doNotUnhash);

            return text;
        }

        function _RunSpanGamut(text) {
            //
            // These are all the transformations that occur *within* block-level
            // tags like paragraphs, headers, and list items.
            //

            text = _DoCodeSpans(text);
            text = _EscapeSpecialCharsWithinTagAttributes(text);
            text = _EncodeBackslashEscapes(text);

            // Process anchor and image tags. Images must come first,
            // because ![foo][f] looks like an anchor.
            text = _DoImages(text);
            text = _DoAnchors(text);

            // Make links out of things like `<http://example.com/>`
            // Must come after _DoAnchors(), because you can use < and >
            // delimiters in inline links like [this](<url>).
            text = _DoAutoLinks(text);
            
            text = text.replace(/~P/g, "://"); // put in place to prevent autolinking; reset now
            
            text = _EncodeAmpsAndAngles(text);
            text = _DoItalicsAndBold(text);

            // Do hard breaks:
            text = text.replace(/  +\n/g, " <br>\n");

            return text;
        }

        function _EscapeSpecialCharsWithinTagAttributes(text) {
            //
            // Within tags -- meaning between < and > -- encode [\ ` * _] so they
            // don't conflict with their use in Markdown for code, italics and strong.
            //

            // Build a regex to find HTML tags and comments.  See Friedl's 
            // "Mastering Regular Expressions", 2nd Ed., pp. 200-201.

            // SE: changed the comment part of the regex

            var regex = /(<[a-z\/!$]("[^"]*"|'[^']*'|[^'">])*>|<!(--(?:|(?:[^>-]|-[^>])(?:[^-]|-[^-])*)--)>)/gi;

            text = text.replace(regex, function (wholeMatch) {
                var tag = wholeMatch.replace(/(.)<\/?code>(?=.)/g, "$1`");
                tag = escapeCharacters(tag, wholeMatch.charAt(1) == "!" ? "\\`*_/" : "\\`*_"); // also escape slashes in comments to prevent autolinking there -- http://meta.stackoverflow.com/questions/95987
                return tag;
            });

            return text;
        }

        function _DoAnchors(text) {
            //
            // Turn Markdown link shortcuts into XHTML <a> tags.
            //
            //
            // First, handle reference-style links: [link text] [id]
            //

            /*
            text = text.replace(/
                (                           // wrap whole match in $1
                    \[
                    (
                        (?:
                            \[[^\]]*\]      // allow brackets nested one level
                            |
                            [^\[]           // or anything else
                        )*
                    )
                    \]

                    [ ]?                    // one optional space
                    (?:\n[ ]*)?             // one optional newline followed by spaces

                    \[
                    (.*?)                   // id = $3
                    \]
                )
                ()()()()                    // pad remaining backreferences
            /g, writeAnchorTag);
            */
            text = text.replace(/(\[((?:\[[^\]]*\]|[^\[\]])*)\][ ]?(?:\n[ ]*)?\[(.*?)\])()()()()/g, writeAnchorTag);

            //
            // Next, inline-style links: [link text](url "optional title")
            //

            /*
            text = text.replace(/
                (                           // wrap whole match in $1
                    \[
                    (
                        (?:
                            \[[^\]]*\]      // allow brackets nested one level
                            |
                            [^\[\]]         // or anything else
                        )*
                    )
                    \]
                    \(                      // literal paren
                    [ \t]*
                    ()                      // no id, so leave $3 empty
                    <?(                     // href = $4
                        (?:
                            \([^)]*\)       // allow one level of (correctly nested) parens (think MSDN)
                            |
                            [^()]
                        )*?
                    )>?                
                    [ \t]*
                    (                       // $5
                        (['"])              // quote char = $6
                        (.*?)               // Title = $7
                        \6                  // matching quote
                        [ \t]*              // ignore any spaces/tabs between closing quote and )
                    )?                      // title is optional
                    \)
                )
            /g, writeAnchorTag);
            */

            text = text.replace(/(\[((?:\[[^\]]*\]|[^\[\]])*)\]\([ \t]*()<?((?:\([^)]*\)|[^()])*?)>?[ \t]*((['"])(.*?)\6[ \t]*)?\))/g, writeAnchorTag);

            //
            // Last, handle reference-style shortcuts: [link text]
            // These must come last in case you've also got [link test][1]
            // or [link test](/foo)
            //

            /*
            text = text.replace(/
                (                   // wrap whole match in $1
                    \[
                    ([^\[\]]+)      // link text = $2; can't contain '[' or ']'
                    \]
                )
                ()()()()()          // pad rest of backreferences
            /g, writeAnchorTag);
            */
            text = text.replace(/(\[([^\[\]]+)\])()()()()()/g, writeAnchorTag);

            return text;
        }

        function writeAnchorTag(wholeMatch, m1, m2, m3, m4, m5, m6, m7) {
            if (m7 == undefined) m7 = "";
            var whole_match = m1;
            var link_text = m2.replace(/:\/\//g, "~P"); // to prevent auto-linking withing the link. will be converted back after the auto-linker runs
            var link_id = m3.toLowerCase();
            var url = m4;
            var title = m7;

            if (url == "") {
                if (link_id == "") {
                    // lower-case and turn embedded newlines into spaces
                    link_id = link_text.toLowerCase().replace(/ ?\n/g, " ");
                }
                url = "#" + link_id;

                if (g_urls.get(link_id) != undefined) {
                    url = g_urls.get(link_id);
                    if (g_titles.get(link_id) != undefined) {
                        title = g_titles.get(link_id);
                    }
                }
                else {
                    if (whole_match.search(/\(\s*\)$/m) > -1) {
                        // Special case for explicit empty url
                        url = "";
                    } else {
                        return whole_match;
                    }
                }
            }
            url = encodeProblemUrlChars(url);
            url = escapeCharacters(url, "*_");
            var result = "<a href=\"" + url + "\"";

            if (title != "") {
                title = attributeEncode(title);
                title = escapeCharacters(title, "*_");
                result += " title=\"" + title + "\"";
            }

            result += ">" + link_text + "</a>";

            return result;
        }

        function _DoImages(text) {
            //
            // Turn Markdown image shortcuts into <img> tags.
            //

            //
            // First, handle reference-style labeled images: ![alt text][id]
            //

            /*
            text = text.replace(/
                (                   // wrap whole match in $1
                    !\[
                    (.*?)           // alt text = $2
                    \]

                    [ ]?            // one optional space
                    (?:\n[ ]*)?     // one optional newline followed by spaces

                    \[
                    (.*?)           // id = $3
                    \]
                )
                ()()()()            // pad rest of backreferences
            /g, writeImageTag);
            */
            text = text.replace(/(!\[(.*?)\][ ]?(?:\n[ ]*)?\[(.*?)\])()()()()/g, writeImageTag);

            //
            // Next, handle inline images:  ![alt text](url "optional title")
            // Don't forget: encode * and _

            /*
            text = text.replace(/
                (                   // wrap whole match in $1
                    !\[
                    (.*?)           // alt text = $2
                    \]
                    \s?             // One optional whitespace character
                    \(              // literal paren
                    [ \t]*
                    ()              // no id, so leave $3 empty
                    <?(\S+?)>?      // src url = $4
                    [ \t]*
                    (               // $5
                        (['"])      // quote char = $6
                        (.*?)       // title = $7
                        \6          // matching quote
                        [ \t]*
                    )?              // title is optional
                    \)
                )
            /g, writeImageTag);
            */
            text = text.replace(/(!\[(.*?)\]\s?\([ \t]*()<?(\S+?)>?[ \t]*((['"])(.*?)\6[ \t]*)?\))/g, writeImageTag);

            return text;
        }
        
        function attributeEncode(text) {
            // unconditionally replace angle brackets here -- what ends up in an attribute (e.g. alt or title)
            // never makes sense to have verbatim HTML in it (and the sanitizer would totally break it)
            return text.replace(/>/g, "&gt;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
        }

        function writeImageTag(wholeMatch, m1, m2, m3, m4, m5, m6, m7) {
            var whole_match = m1;
            var alt_text = m2;
            var link_id = m3.toLowerCase();
            var url = m4;
            var title = m7;

            if (!title) title = "";

            if (url == "") {
                if (link_id == "") {
                    // lower-case and turn embedded newlines into spaces
                    link_id = alt_text.toLowerCase().replace(/ ?\n/g, " ");
                }
                url = "#" + link_id;

                if (g_urls.get(link_id) != undefined) {
                    url = g_urls.get(link_id);
                    if (g_titles.get(link_id) != undefined) {
                        title = g_titles.get(link_id);
                    }
                }
                else {
                    return whole_match;
                }
            }
            
            alt_text = escapeCharacters(attributeEncode(alt_text), "*_[]()");
            url = escapeCharacters(url, "*_");
            var result = "<img src=\"" + url + "\" alt=\"" + alt_text + "\"";

            // attacklab: Markdown.pl adds empty title attributes to images.
            // Replicate this bug.

            //if (title != "") {
            title = attributeEncode(title);
            title = escapeCharacters(title, "*_");
            result += " title=\"" + title + "\"";
            //}

            result += " />";

            return result;
        }

        function _DoHeaders(text) {

            // Setext-style headers:
            //  Header 1
            //  ========
            //  
            //  Header 2
            //  --------
            //
            text = text.replace(/^(.+)[ \t]*\n=+[ \t]*\n+/gm,
                function (wholeMatch, m1) { return "<h1>" + _RunSpanGamut(m1) + "</h1>\n\n"; }
            );

            text = text.replace(/^(.+)[ \t]*\n-+[ \t]*\n+/gm,
                function (matchFound, m1) { return "<h2>" + _RunSpanGamut(m1) + "</h2>\n\n"; }
            );

            // atx-style headers:
            //  # Header 1
            //  ## Header 2
            //  ## Header 2 with closing hashes ##
            //  ...
            //  ###### Header 6
            //

            /*
            text = text.replace(/
                ^(\#{1,6})      // $1 = string of #'s
                [ \t]*
                (.+?)           // $2 = Header text
                [ \t]*
                \#*             // optional closing #'s (not counted)
                \n+
            /gm, function() {...});
            */

            text = text.replace(/^(\#{1,6})[ \t]*(.+?)[ \t]*\#*\n+/gm,
                function (wholeMatch, m1, m2) {
                    var h_level = m1.length;
                    return "<h" + h_level + ">" + _RunSpanGamut(m2) + "</h" + h_level + ">\n\n";
                }
            );

            return text;
        }

        function _DoLists(text) {
            //
            // Form HTML ordered (numbered) and unordered (bulleted) lists.
            //

            // attacklab: add sentinel to hack around khtml/safari bug:
            // http://bugs.webkit.org/show_bug.cgi?id=11231
            text += "~0";

            // Re-usable pattern to match any entirel ul or ol list:

            /*
            var whole_list = /
                (                                   // $1 = whole list
                    (                               // $2
                        [ ]{0,3}                    // attacklab: g_tab_width - 1
                        ([*+-]|\d+[.])              // $3 = first list item marker
                        [ \t]+
                    )
                    [^\r]+?
                    (                               // $4
                        ~0                          // sentinel for workaround; should be $
                        |
                        \n{2,}
                        (?=\S)
                        (?!                         // Negative lookahead for another list item marker
                            [ \t]*
                            (?:[*+-]|\d+[.])[ \t]+
                        )
                    )
                )
            /g
            */
            var whole_list = /^(([ ]{0,3}([*+-]|\d+[.])[ \t]+)[^\r]+?(~0|\n{2,}(?=\S)(?![ \t]*(?:[*+-]|\d+[.])[ \t]+)))/gm;

            if (g_list_level) {
                text = text.replace(whole_list, function (wholeMatch, m1, m2) {
                    var list = m1;
                    var list_type = (m2.search(/[*+-]/g) > -1) ? "ul" : "ol";

                    var result = _ProcessListItems(list, list_type);

                    // Trim any trailing whitespace, to put the closing `</$list_type>`
                    // up on the preceding line, to get it past the current stupid
                    // HTML block parser. This is a hack to work around the terrible
                    // hack that is the HTML block parser.
                    result = result.replace(/\s+$/, "");
                    result = "<" + list_type + ">" + result + "</" + list_type + ">\n";
                    return result;
                });
            } else {
                whole_list = /(\n\n|^\n?)(([ ]{0,3}([*+-]|\d+[.])[ \t]+)[^\r]+?(~0|\n{2,}(?=\S)(?![ \t]*(?:[*+-]|\d+[.])[ \t]+)))/g;
                text = text.replace(whole_list, function (wholeMatch, m1, m2, m3) {
                    var runup = m1;
                    var list = m2;

                    var list_type = (m3.search(/[*+-]/g) > -1) ? "ul" : "ol";
                    var result = _ProcessListItems(list, list_type);
                    result = runup + "<" + list_type + ">\n" + result + "</" + list_type + ">\n";
                    return result;
                });
            }

            // attacklab: strip sentinel
            text = text.replace(/~0/, "");

            return text;
        }

        var _listItemMarkers = { ol: "\\d+[.]", ul: "[*+-]" };

        function _ProcessListItems(list_str, list_type) {
            //
            //  Process the contents of a single ordered or unordered list, splitting it
            //  into individual list items.
            //
            //  list_type is either "ul" or "ol".

            // The $g_list_level global keeps track of when we're inside a list.
            // Each time we enter a list, we increment it; when we leave a list,
            // we decrement. If it's zero, we're not in a list anymore.
            //
            // We do this because when we're not inside a list, we want to treat
            // something like this:
            //
            //    I recommend upgrading to version
            //    8. Oops, now this line is treated
            //    as a sub-list.
            //
            // As a single paragraph, despite the fact that the second line starts
            // with a digit-period-space sequence.
            //
            // Whereas when we're inside a list (or sub-list), that line will be
            // treated as the start of a sub-list. What a kludge, huh? This is
            // an aspect of Markdown's syntax that's hard to parse perfectly
            // without resorting to mind-reading. Perhaps the solution is to
            // change the syntax rules such that sub-lists must start with a
            // starting cardinal number; e.g. "1." or "a.".

            g_list_level++;

            // trim trailing blank lines:
            list_str = list_str.replace(/\n{2,}$/, "\n");

            // attacklab: add sentinel to emulate \z
            list_str += "~0";

            // In the original attacklab showdown, list_type was not given to this function, and anything
            // that matched /[*+-]|\d+[.]/ would just create the next <li>, causing this mismatch:
            //
            //  Markdown          rendered by WMD        rendered by MarkdownSharp
            //  ------------------------------------------------------------------
            //  1. first          1. first               1. first
            //  2. second         2. second              2. second
            //  - third           3. third                   * third
            //
            // We changed this to behave identical to MarkdownSharp. This is the constructed RegEx,
            // with {MARKER} being one of \d+[.] or [*+-], depending on list_type:
        
            /*
            list_str = list_str.replace(/
                (^[ \t]*)                       // leading whitespace = $1
                ({MARKER}) [ \t]+               // list marker = $2
                ([^\r]+?                        // list item text   = $3
                    (\n+)
                )
                (?=
                    (~0 | \2 ({MARKER}) [ \t]+)
                )
            /gm, function(){...});
            */

            var marker = _listItemMarkers[list_type];
            var re = new RegExp("(^[ \\t]*)(" + marker + ")[ \\t]+([^\\r]+?(\\n+))(?=(~0|\\1(" + marker + ")[ \\t]+))", "gm");
            var last_item_had_a_double_newline = false;
            list_str = list_str.replace(re,
                function (wholeMatch, m1, m2, m3) {
                    var item = m3;
                    var leading_space = m1;
                    var ends_with_double_newline = /\n\n$/.test(item);
                    var contains_double_newline = ends_with_double_newline || item.search(/\n{2,}/) > -1;

                    if (contains_double_newline || last_item_had_a_double_newline) {
                        item = _RunBlockGamut(_Outdent(item), /* doNotUnhash = */true);
                    }
                    else {
                        // Recursion for sub-lists:
                        item = _DoLists(_Outdent(item));
                        item = item.replace(/\n$/, ""); // chomp(item)
                        item = _RunSpanGamut(item);
                    }
                    last_item_had_a_double_newline = ends_with_double_newline;
                    return "<li>" + item + "</li>\n";
                }
            );

            // attacklab: strip sentinel
            list_str = list_str.replace(/~0/g, "");

            g_list_level--;
            return list_str;
        }

        function _DoCodeBlocks(text) {
            //
            //  Process Markdown `<pre><code>` blocks.
            //  

            /*
            text = text.replace(/
                (?:\n\n|^)
                (                               // $1 = the code block -- one or more lines, starting with a space/tab
                    (?:
                        (?:[ ]{4}|\t)           // Lines must start with a tab or a tab-width of spaces - attacklab: g_tab_width
                        .*\n+
                    )+
                )
                (\n*[ ]{0,3}[^ \t\n]|(?=~0))    // attacklab: g_tab_width
            /g ,function(){...});
            */

            // attacklab: sentinel workarounds for lack of \A and \Z, safari\khtml bug
            text += "~0";

            text = text.replace(/(?:\n\n|^)((?:(?:[ ]{4}|\t).*\n+)+)(\n*[ ]{0,3}[^ \t\n]|(?=~0))/g,
                function (wholeMatch, m1, m2) {
                    var codeblock = m1;
                    var nextChar = m2;

                    codeblock = _EncodeCode(_Outdent(codeblock));
                    codeblock = _Detab(codeblock);
                    codeblock = codeblock.replace(/^\n+/g, ""); // trim leading newlines
                    codeblock = codeblock.replace(/\n+$/g, ""); // trim trailing whitespace

                    codeblock = '<pre class="prettyprint"><code>' + codeblock + '\n</code></pre>';

                    return "\n\n" + codeblock + "\n\n" + nextChar;
                }
            );

            // attacklab: strip sentinel
            text = text.replace(/~0/, "");

            return text;
        }

        function hashBlock(text) {
            text = text.replace(/(^\n+|\n+$)/g, "");
            return "\n\n~K" + (g_html_blocks.push(text) - 1) + "K\n\n";
        }

        function _DoCodeSpans(text) {
            //
            // * Backtick quotes are used for <code></code> spans.
            // 
            // * You can use multiple backticks as the delimiters if you want to
            //   include literal backticks in the code span. So, this input:
            //     
            //      Just type ``foo `bar` baz`` at the prompt.
            //     
            //   Will translate to:
            //     
            //      <p>Just type <code>foo `bar` baz</code> at the prompt.</p>
            //     
            //   There's no arbitrary limit to the number of backticks you
            //   can use as delimters. If you need three consecutive backticks
            //   in your code, use four for delimiters, etc.
            //
            // * You can use spaces to get literal backticks at the edges:
            //     
            //      ... type `` `bar` `` ...
            //     
            //   Turns to:
            //     
            //      ... type <code>`bar`</code> ...
            //

            /*
            text = text.replace(/
                (^|[^\\])       // Character before opening ` can't be a backslash
                (`+)            // $2 = Opening run of `
                (               // $3 = The code block
                    [^\r]*?
                    [^`]        // attacklab: work around lack of lookbehind
                )
                \2              // Matching closer
                (?!`)
            /gm, function(){...});
            */

            text = text.replace(/(^|[^\\])(`+)([^\r]*?[^`])\2(?!`)/gm,
                function (wholeMatch, m1, m2, m3, m4) {
                    var c = m3;
                    c = c.replace(/^([ \t]*)/g, ""); // leading whitespace
                    c = c.replace(/[ \t]*$/g, ""); // trailing whitespace
                    c = _EncodeCode(c);
                    c = c.replace(/:\/\//g, "~P"); // to prevent auto-linking. Not necessary in code *blocks*, but in code spans. Will be converted back after the auto-linker runs.
                    return m1 + "<code>" + c + "</code>";
                }
            );

            return text;
        }

        function _EncodeCode(text) {
            //
            // Encode/escape certain characters inside Markdown code runs.
            // The point is that in code, these characters are literals,
            // and lose their special Markdown meanings.
            //
            // Encode all ampersands; HTML entities are not
            // entities within a Markdown code span.
            text = text.replace(/&/g, "&amp;");

            // Do the angle bracket song and dance:
            text = text.replace(/</g, "&lt;");
            text = text.replace(/>/g, "&gt;");

            // Now, escape characters that are magic in Markdown:
            text = escapeCharacters(text, "\*_{}[]\\", false);

            // jj the line above breaks this:
            //---

            //* Item

            //   1. Subitem

            //            special char: *
            //---

            return text;
        }

        function _DoItalicsAndBold(text) {

            // <strong> must go first:
            text = text.replace(/([\W_]|^)(\*\*|__)(?=\S)([^\r]*?\S[\*_]*)\2([\W_]|$)/g,
            "$1<strong>$3</strong>$4");

            text = text.replace(/([\W_]|^)(\*|_)(?=\S)([^\r\*_]*?\S)\2([\W_]|$)/g,
            "$1<em>$3</em>$4");

            return text;
        }

        function _DoBlockQuotes(text) {

            /*
            text = text.replace(/
                (                           // Wrap whole match in $1
                    (
                        ^[ \t]*>[ \t]?      // '>' at the start of a line
                        .+\n                // rest of the first line
                        (.+\n)*             // subsequent consecutive lines
                        \n*                 // blanks
                    )+
                )
            /gm, function(){...});
            */

            text = text.replace(/((^[ \t]*>[ \t]?.+\n(.+\n)*\n*)+)/gm,
                function (wholeMatch, m1) {
                    var bq = m1;

                    // attacklab: hack around Konqueror 3.5.4 bug:
                    // "----------bug".replace(/^-/g,"") == "bug"

                    bq = bq.replace(/^[ \t]*>[ \t]?/gm, "~0"); // trim one level of quoting

                    // attacklab: clean up hack
                    bq = bq.replace(/~0/g, "");

                    bq = bq.replace(/^[ \t]+$/gm, "");     // trim whitespace-only lines
                    bq = _RunBlockGamut(bq);             // recurse

                    bq = bq.replace(/(^|\n)/g, "$1  ");
                    // These leading spaces screw with <pre> content, so we need to fix that:
                    bq = bq.replace(
                            /(\s*<pre>[^\r]+?<\/pre>)/gm,
                        function (wholeMatch, m1) {
                            var pre = m1;
                            // attacklab: hack around Konqueror 3.5.4 bug:
                            pre = pre.replace(/^  /mg, "~0");
                            pre = pre.replace(/~0/g, "");
                            return pre;
                        });

                    return hashBlock("<blockquote>\n" + bq + "\n</blockquote>");
                }
            );
            return text;
        }

        function _FormParagraphs(text, doNotUnhash) {
            //
            //  Params:
            //    $text - string to process with html <p> tags
            //

            // Strip leading and trailing lines:
            text = text.replace(/^\n+/g, "");
            text = text.replace(/\n+$/g, "");

            var grafs = text.split(/\n{2,}/g);
            var grafsOut = [];
            
            var markerRe = /~K(\d+)K/;

            //
            // Wrap <p> tags.
            //
            var end = grafs.length;
            for (var i = 0; i < end; i++) {
                var str = grafs[i];

                // if this is an HTML marker, copy it
                if (markerRe.test(str)) {
                    grafsOut.push(str);
                }
                else if (/\S/.test(str)) {
                    str = _RunSpanGamut(str);
                    str = str.replace(/^([ \t]*)/g, "<p>");
                    str += "</p>"
                    grafsOut.push(str);
                }

            }
            //
            // Unhashify HTML blocks
            //
            if (!doNotUnhash) {
                end = grafsOut.length;
                for (var i = 0; i < end; i++) {
                    var foundAny = true;
                    while (foundAny) { // we may need several runs, since the data may be nested
                        foundAny = false;
                        grafsOut[i] = grafsOut[i].replace(/~K(\d+)K/g, function (wholeMatch, id) {
                            foundAny = true;
                            return g_html_blocks[id];
                        });
                    }
                }
            }
            return grafsOut.join("\n\n");
        }

        function _EncodeAmpsAndAngles(text) {
            // Smart processing for ampersands and angle brackets that need to be encoded.

            // Ampersand-encoding based entirely on Nat Irons's Amputator MT plugin:
            //   http://bumppo.net/projects/amputator/
            text = text.replace(/&(?!#?[xX]?(?:[0-9a-fA-F]+|\w+);)/g, "&amp;");

            // Encode naked <'s
            text = text.replace(/<(?![a-z\/?\$!])/gi, "&lt;");

            return text;
        }

        function _EncodeBackslashEscapes(text) {
            //
            //   Parameter:  String.
            //   Returns:    The string, with after processing the following backslash
            //               escape sequences.
            //

            // attacklab: The polite way to do this is with the new
            // escapeCharacters() function:
            //
            //     text = escapeCharacters(text,"\\",true);
            //     text = escapeCharacters(text,"`*_{}[]()>#+-.!",true);
            //
            // ...but we're sidestepping its use of the (slow) RegExp constructor
            // as an optimization for Firefox.  This function gets called a LOT.

            text = text.replace(/\\(\\)/g, escapeCharacters_callback);
            text = text.replace(/\\([`*_{}\[\]()>#+-.!])/g, escapeCharacters_callback);
            return text;
        }

        function _DoAutoLinks(text) {

            // note that at this point, all other URL in the text are already hyperlinked as <a href=""></a>
            // *except* for the <http://www.foo.com> case

            // automatically add < and > around unadorned raw hyperlinks
            // must be preceded by space/BOF and followed by non-word/EOF character    
            text = text.replace(/(^|\s)(https?|ftp)(:\/\/[-A-Z0-9+&@#\/%?=~_|\[\]\(\)!:,\.;]*[-A-Z0-9+&@#\/%=~_|\[\]])($|\W)/gi, "$1<$2$3>$4");

            //  autolink anything like <http://example.com>
            
            var replacer = function (wholematch, m1) { return "<a href=\"" + m1 + "\">" + pluginHooks.plainLinkText(m1) + "</a>"; }
            text = text.replace(/<((https?|ftp):[^'">\s]+)>/gi, replacer);

            // Email addresses: <address@domain.foo>
            /*
            text = text.replace(/
                <
                (?:mailto:)?
                (
                    [-.\w]+
                    \@
                    [-a-z0-9]+(\.[-a-z0-9]+)*\.[a-z]+
                )
                >
            /gi, _DoAutoLinks_callback());
            */

            var email_replacer = function(wholematch, m1) {
                var mailto = 'mailto:'
                var link
                var email
                if (m1.substring(0, mailto.length) != mailto){
                    link = mailto + m1;
                    email = m1;
                } else {
                    link = m1;
                    email = m1.substring(mailto.length, m1.length);
                }
                return "<a href=\"" + link + "\">" + pluginHooks.plainLinkText(email) + "</a>";
            }
            text = text.replace(/<((?:mailto:)?([-.\w]+\@[-a-z0-9]+(\.[-a-z0-9]+)*\.[a-z]+))>/gi, email_replacer);

            return text;
        }

        function _UnescapeSpecialChars(text) {
            //
            // Swap back in all the special characters we've hidden.
            //
            text = text.replace(/~E(\d+)E/g,
                function (wholeMatch, m1) {
                    var charCodeToReplace = parseInt(m1);
                    return String.fromCharCode(charCodeToReplace);
                }
            );
            return text;
        }

        function _Outdent(text) {
            //
            // Remove one level of line-leading tabs or spaces
            //

            // attacklab: hack around Konqueror 3.5.4 bug:
            // "----------bug".replace(/^-/g,"") == "bug"

            text = text.replace(/^(\t|[ ]{1,4})/gm, "~0"); // attacklab: g_tab_width

            // attacklab: clean up hack
            text = text.replace(/~0/g, "")

            return text;
        }

        function _Detab(text) {
            if (!/\t/.test(text))
                return text;

            var spaces = ["    ", "   ", "  ", " "],
            skew = 0,
            v;

            return text.replace(/[\n\t]/g, function (match, offset) {
                if (match === "\n") {
                    skew = offset + 1;
                    return match;
                }
                v = (offset - skew) % 4;
                skew = offset + 1;
                return spaces[v];
            });
        }

        //
        //  attacklab: Utility functions
        //

        var _problemUrlChars = /(?:["'*()[\]:]|~D)/g;

        // hex-encodes some unusual "problem" chars in URLs to avoid URL detection problems 
        function encodeProblemUrlChars(url) {
            if (!url)
                return "";

            var len = url.length;

            return url.replace(_problemUrlChars, function (match, offset) {
                if (match == "~D") // escape for dollar
                    return "%24";
                if (match == ":") {
                    if (offset == len - 1 || /[0-9\/]/.test(url.charAt(offset + 1)))
                        return ":";
                    if (url.substring(0, 'mailto:'.length) === 'mailto:')
                        return ":";
                    if (url.substring(0, 'magnet:'.length) === 'magnet:')
                        return ":";
                }
                return "%" + match.charCodeAt(0).toString(16);
            });
        }


        function escapeCharacters(text, charsToEscape, afterBackslash) {
            // First we have to escape the escape characters so that
            // we can build a character class out of them
            var regexString = "([" + charsToEscape.replace(/([\[\]\\])/g, "\\$1") + "])";

            if (afterBackslash) {
                regexString = "\\\\" + regexString;
            }

            var regex = new RegExp(regexString, "g");
            text = text.replace(regex, escapeCharacters_callback);

            return text;
        }


        function escapeCharacters_callback(wholeMatch, m1) {
            var charCodeToEscape = m1.charCodeAt(0);
            return "~E" + charCodeToEscape + "E";
        }

    }; // end of the Markdown.Converter constructor

})();
// needs Markdown.Converter.js at the moment

(function () {

    var util = {},
        position = {},
        ui = {},
        doc = window.document,
        re = window.RegExp,
        nav = window.navigator,
        SETTINGS = { lineLength: 72 },

    // Used to work around some browser bugs where we can't use feature testing.
        uaSniffed = {
            isIE: /msie/.test(nav.userAgent.toLowerCase()),
            isIE_5or6: /msie 6/.test(nav.userAgent.toLowerCase()) || /msie 5/.test(nav.userAgent.toLowerCase()),
            isOpera: /opera/.test(nav.userAgent.toLowerCase())
        };


    // -------------------------------------------------------------------
    //  YOUR CHANGES GO HERE
    //
    // I've tried to localize the things you are likely to change to 
    // this area.
    // -------------------------------------------------------------------

    // The text that appears on the upper part of the dialog box when
    // entering links.
    var linkDialogText = "";//<p>http://example.com/ \"optional title\"</p>";
    var imageDialogText = "<p>http://example.com/images/diagram.jpg \"optional title\"</p>";

    // The default text that appears in the dialog input box when entering
    // links.
    var imageDefaultText = "http://";
    var linkDefaultText = "http://";

    var defaultHelpHoverTitle = "Markdown Editing Help";

    // -------------------------------------------------------------------
    //  END OF YOUR CHANGES
    // -------------------------------------------------------------------

    // help, if given, should have a property "handler", the click handler for the help button,
    // and can have an optional property "title" for the button's tooltip (defaults to "Markdown Editing Help").
    // If help isn't given, not help button is created.
    //
    // The constructed editor object has the methods:
    // - getConverter() returns the markdown converter object that was passed to the constructor
    // - run() actually starts the editor; should be called after all necessary plugins are registered. Calling this more than once is a no-op.
    // - refreshPreview() forces the preview to be updated. This method is only available after run() was called.
    Markdown.Editor = function (markdownConverter, idPostfix, help) {

        idPostfix = idPostfix || "";

        var hooks = this.hooks = new Markdown.HookCollection();
        hooks.addNoop("onPreviewRefresh");       // called with no arguments after the preview has been refreshed
        hooks.addNoop("postBlockquoteCreation"); // called with the user's selection *after* the blockquote was created; should return the actual to-be-inserted text
        hooks.addFalse("insertImageDialog");     /* called with one parameter: a callback to be called with the URL of the image. If the application creates
                                                  * its own image insertion dialog, this hook should return true, and the callback should be called with the chosen
                                                  * image url (or null if the user cancelled). If this hook returns false, the default dialog will be used.
                                                  */

        this.getConverter = function () { return markdownConverter; }

        var that = this,
            panels;

        this.run = function () {
            if (panels)
                return; // already initialized

            panels = new PanelCollection(idPostfix);
            var commandManager = new CommandManager(hooks);
            var previewManager = new PreviewManager(markdownConverter, panels, function () { hooks.onPreviewRefresh(); });
            var undoManager, uiManager;

            if (!/\?noundo/.test(doc.location.href)) {
                undoManager = new UndoManager(function () {
                    previewManager.refresh();
                    if (uiManager) // not available on the first call
                        uiManager.setUndoRedoButtonStates();
                }, panels);
                this.textOperation = function (f) {
                    undoManager.setCommandMode();
                    f();
                    that.refreshPreview();
                }
            }

            uiManager = new UIManager(idPostfix, panels, undoManager, previewManager, commandManager, help);
            uiManager.setUndoRedoButtonStates();

            var forceRefresh = that.refreshPreview = function () { previewManager.refresh(true); };

            forceRefresh();
        };

    }

    // before: contains all the text in the input box BEFORE the selection.
    // after: contains all the text in the input box AFTER the selection.
    function Chunks() { }

    // startRegex: a regular expression to find the start tag
    // endRegex: a regular expresssion to find the end tag
    Chunks.prototype.findTags = function (startRegex, endRegex) {

        var chunkObj = this;
        var regex;

        if (startRegex) {

            regex = util.extendRegExp(startRegex, "", "$");

            this.before = this.before.replace(regex,
                function (match) {
                    chunkObj.startTag = chunkObj.startTag + match;
                    return "";
                });

            regex = util.extendRegExp(startRegex, "^", "");

            this.selection = this.selection.replace(regex,
                function (match) {
                    chunkObj.startTag = chunkObj.startTag + match;
                    return "";
                });
        }

        if (endRegex) {

            regex = util.extendRegExp(endRegex, "", "$");

            this.selection = this.selection.replace(regex,
                function (match) {
                    chunkObj.endTag = match + chunkObj.endTag;
                    return "";
                });

            regex = util.extendRegExp(endRegex, "^", "");

            this.after = this.after.replace(regex,
                function (match) {
                    chunkObj.endTag = match + chunkObj.endTag;
                    return "";
                });
        }
    };

    // If remove is false, the whitespace is transferred
    // to the before/after regions.
    //
    // If remove is true, the whitespace disappears.
    Chunks.prototype.trimWhitespace = function (remove) {
        var beforeReplacer, afterReplacer, that = this;
        if (remove) {
            beforeReplacer = afterReplacer = "";
        } else {
            beforeReplacer = function (s) { that.before += s; return ""; }
            afterReplacer = function (s) { that.after = s + that.after; return ""; }
        }
        
        this.selection = this.selection.replace(/^(\s*)/, beforeReplacer).replace(/(\s*)$/, afterReplacer);
    };


    Chunks.prototype.skipLines = function (nLinesBefore, nLinesAfter, findExtraNewlines) {

        if (nLinesBefore === undefined) {
            nLinesBefore = 1;
        }

        if (nLinesAfter === undefined) {
            nLinesAfter = 1;
        }

        nLinesBefore++;
        nLinesAfter++;

        var regexText;
        var replacementText;

        // chrome bug ... documented at: http://meta.stackoverflow.com/questions/63307/blockquote-glitch-in-editor-in-chrome-6-and-7/65985#65985
        if (navigator.userAgent.match(/Chrome/)) {
            "X".match(/()./);
        }

        this.selection = this.selection.replace(/(^\n*)/, "");

        this.startTag = this.startTag + re.$1;

        this.selection = this.selection.replace(/(\n*$)/, "");
        this.endTag = this.endTag + re.$1;
        this.startTag = this.startTag.replace(/(^\n*)/, "");
        this.before = this.before + re.$1;
        this.endTag = this.endTag.replace(/(\n*$)/, "");
        this.after = this.after + re.$1;

        if (this.before) {

            regexText = replacementText = "";

            while (nLinesBefore--) {
                regexText += "\\n?";
                replacementText += "\n";
            }

            if (findExtraNewlines) {
                regexText = "\\n*";
            }
            this.before = this.before.replace(new re(regexText + "$", ""), replacementText);
        }

        if (this.after) {

            regexText = replacementText = "";

            while (nLinesAfter--) {
                regexText += "\\n?";
                replacementText += "\n";
            }
            if (findExtraNewlines) {
                regexText = "\\n*";
            }

            this.after = this.after.replace(new re(regexText, ""), replacementText);
        }
    };

    // end of Chunks 

    // A collection of the important regions on the page.
    // Cached so we don't have to keep traversing the DOM.
    // Also holds ieCachedRange and ieCachedScrollTop, where necessary; working around
    // this issue:
    // Internet explorer has problems with CSS sprite buttons that use HTML
    // lists.  When you click on the background image "button", IE will 
    // select the non-existent link text and discard the selection in the
    // textarea.  The solution to this is to cache the textarea selection
    // on the button's mousedown event and set a flag.  In the part of the
    // code where we need to grab the selection, we check for the flag
    // and, if it's set, use the cached area instead of querying the
    // textarea.
    //
    // This ONLY affects Internet Explorer (tested on versions 6, 7
    // and 8) and ONLY on button clicks.  Keyboard shortcuts work
    // normally since the focus never leaves the textarea.
    function PanelCollection(postfix) {
        this.buttonBar = doc.getElementById("wmd-button-bar" + postfix);
        this.preview = doc.getElementById("wmd-preview" + postfix);
        this.input = doc.getElementById("wmd-input" + postfix);
    };

    // Returns true if the DOM element is visible, false if it's hidden.
    // Checks if display is anything other than none.
    util.isVisible = function (elem) {

        if (window.getComputedStyle) {
            // Most browsers
            return window.getComputedStyle(elem, null).getPropertyValue("display") !== "none";
        }
        else if (elem.currentStyle) {
            // IE
            return elem.currentStyle["display"] !== "none";
        }
    };


    // Adds a listener callback to a DOM element which is fired on a specified
    // event.
    util.addEvent = function (elem, event, listener) {
        if (elem.attachEvent) {
            // IE only.  The "on" is mandatory.
            elem.attachEvent("on" + event, listener);
        }
        else {
            // Other browsers.
            elem.addEventListener(event, listener, false);
        }
    };


    // Removes a listener callback from a DOM element which is fired on a specified
    // event.
    util.removeEvent = function (elem, event, listener) {
        if (elem.detachEvent) {
            // IE only.  The "on" is mandatory.
            elem.detachEvent("on" + event, listener);
        }
        else {
            // Other browsers.
            elem.removeEventListener(event, listener, false);
        }
    };

    // Converts \r\n and \r to \n.
    util.fixEolChars = function (text) {
        text = text.replace(/\r\n/g, "\n");
        text = text.replace(/\r/g, "\n");
        return text;
    };

    // Extends a regular expression.  Returns a new RegExp
    // using pre + regex + post as the expression.
    // Used in a few functions where we have a base
    // expression and we want to pre- or append some
    // conditions to it (e.g. adding "$" to the end).
    // The flags are unchanged.
    //
    // regex is a RegExp, pre and post are strings.
    util.extendRegExp = function (regex, pre, post) {

        if (pre === null || pre === undefined) {
            pre = "";
        }
        if (post === null || post === undefined) {
            post = "";
        }

        var pattern = regex.toString();
        var flags;

        // Replace the flags with empty space and store them.
        pattern = pattern.replace(/\/([gim]*)$/, function (wholeMatch, flagsPart) {
            flags = flagsPart;
            return "";
        });

        // Remove the slash delimiters on the regular expression.
        pattern = pattern.replace(/(^\/|\/$)/g, "");
        pattern = pre + pattern + post;

        return new re(pattern, flags);
    }

    // UNFINISHED
    // The assignment in the while loop makes jslint cranky.
    // I'll change it to a better loop later.
    position.getTop = function (elem, isInner) {
        var result = elem.offsetTop;
        if (!isInner) {
            while (elem = elem.offsetParent) {
                result += elem.offsetTop;
            }
        }
        return result;
    };

    position.getHeight = function (elem) {
        return elem.offsetHeight || elem.scrollHeight;
    };

    position.getWidth = function (elem) {
        return elem.offsetWidth || elem.scrollWidth;
    };

    position.getPageSize = function () {

        var scrollWidth, scrollHeight;
        var innerWidth, innerHeight;

        // It's not very clear which blocks work with which browsers.
        if (self.innerHeight && self.scrollMaxY) {
            scrollWidth = doc.body.scrollWidth;
            scrollHeight = self.innerHeight + self.scrollMaxY;
        }
        else if (doc.body.scrollHeight > doc.body.offsetHeight) {
            scrollWidth = doc.body.scrollWidth;
            scrollHeight = doc.body.scrollHeight;
        }
        else {
            scrollWidth = doc.body.offsetWidth;
            scrollHeight = doc.body.offsetHeight;
        }

        if (self.innerHeight) {
            // Non-IE browser
            innerWidth = self.innerWidth;
            innerHeight = self.innerHeight;
        }
        else if (doc.documentElement && doc.documentElement.clientHeight) {
            // Some versions of IE (IE 6 w/ a DOCTYPE declaration)
            innerWidth = doc.documentElement.clientWidth;
            innerHeight = doc.documentElement.clientHeight;
        }
        else if (doc.body) {
            // Other versions of IE
            innerWidth = doc.body.clientWidth;
            innerHeight = doc.body.clientHeight;
        }

        var maxWidth = Math.max(scrollWidth, innerWidth);
        var maxHeight = Math.max(scrollHeight, innerHeight);
        return [maxWidth, maxHeight, innerWidth, innerHeight];
    };

    // Handles pushing and popping TextareaStates for undo/redo commands.
    // I should rename the stack variables to list.
    function UndoManager(callback, panels) {

        var undoObj = this;
        var undoStack = []; // A stack of undo states
        var stackPtr = 0; // The index of the current state
        var mode = "none";
        var lastState; // The last state
        var timer; // The setTimeout handle for cancelling the timer
        var inputStateObj;

        // Set the mode for later logic steps.
        var setMode = function (newMode, noSave) {
            if (mode != newMode) {
                mode = newMode;
                if (!noSave) {
                    saveState();
                }
            }

            if (!uaSniffed.isIE || mode != "moving") {
                timer = setTimeout(refreshState, 1);
            }
            else {
                inputStateObj = null;
            }
        };

        var refreshState = function (isInitialState) {
            inputStateObj = new TextareaState(panels, isInitialState);
            timer = undefined;
        };

        this.setCommandMode = function () {
            mode = "command";
            saveState();
            timer = setTimeout(refreshState, 0);
        };

        this.canUndo = function () {
            return stackPtr > 1;
        };

        this.canRedo = function () {
            if (undoStack[stackPtr + 1]) {
                return true;
            }
            return false;
        };

        // Removes the last state and restores it.
        this.undo = function () {

            if (undoObj.canUndo()) {
                if (lastState) {
                    // What about setting state -1 to null or checking for undefined?
                    lastState.restore();
                    lastState = null;
                }
                else {
                    undoStack[stackPtr] = new TextareaState(panels);
                    undoStack[--stackPtr].restore();

                    if (callback) {
                        callback();
                    }
                }
            }

            mode = "none";
            panels.input.focus();
            refreshState();
        };

        // Redo an action.
        this.redo = function () {

            if (undoObj.canRedo()) {

                undoStack[++stackPtr].restore();

                if (callback) {
                    callback();
                }
            }

            mode = "none";
            panels.input.focus();
            refreshState();
        };

        // Push the input area state to the stack.
        var saveState = function () {
            var currState = inputStateObj || new TextareaState(panels);

            if (!currState) {
                return false;
            }
            if (mode == "moving") {
                if (!lastState) {
                    lastState = currState;
                }
                return;
            }
            if (lastState) {
                if (undoStack[stackPtr - 1].text != lastState.text) {
                    undoStack[stackPtr++] = lastState;
                }
                lastState = null;
            }
            undoStack[stackPtr++] = currState;
            undoStack[stackPtr + 1] = null;
            if (callback) {
                callback();
            }
        };

        var handleCtrlYZ = function (event) {

            var handled = false;

            if (event.ctrlKey || event.metaKey) {

                // IE and Opera do not support charCode.
                var keyCode = event.charCode || event.keyCode;
                var keyCodeChar = String.fromCharCode(keyCode);

                switch (keyCodeChar) {

                    case "y":
                        undoObj.redo();
                        handled = true;
                        break;

                    case "z":
                        if (!event.shiftKey) {
                            undoObj.undo();
                        }
                        else {
                            undoObj.redo();
                        }
                        handled = true;
                        break;
                }
            }

            if (handled) {
                if (event.preventDefault) {
                    event.preventDefault();
                }
                if (window.event) {
                    window.event.returnValue = false;
                }
                return;
            }
        };

        // Set the mode depending on what is going on in the input area.
        var handleModeChange = function (event) {

            if (!event.ctrlKey && !event.metaKey) {

                var keyCode = event.keyCode;

                if ((keyCode >= 33 && keyCode <= 40) || (keyCode >= 63232 && keyCode <= 63235)) {
                    // 33 - 40: page up/dn and arrow keys
                    // 63232 - 63235: page up/dn and arrow keys on safari
                    setMode("moving");
                }
                else if (keyCode == 8 || keyCode == 46 || keyCode == 127) {
                    // 8: backspace
                    // 46: delete
                    // 127: delete
                    setMode("deleting");
                }
                else if (keyCode == 13) {
                    // 13: Enter
                    setMode("newlines");
                }
                else if (keyCode == 27) {
                    // 27: escape
                    setMode("escape");
                }
                else if ((keyCode < 16 || keyCode > 20) && keyCode != 91) {
                    // 16-20 are shift, etc. 
                    // 91: left window key
                    // I think this might be a little messed up since there are
                    // a lot of nonprinting keys above 20.
                    setMode("typing");
                }
            }
        };

        var setEventHandlers = function () {
            util.addEvent(panels.input, "keypress", function (event) {
                // keyCode 89: y
                // keyCode 90: z
                if ((event.ctrlKey || event.metaKey) && (event.keyCode == 89 || event.keyCode == 90)) {
                    event.preventDefault();
                }
            });

            var handlePaste = function () {
                if (uaSniffed.isIE || (inputStateObj && inputStateObj.text != panels.input.value)) {
                    if (timer == undefined) {
                        mode = "paste";
                        saveState();
                        refreshState();
                    }
                }
            };

            util.addEvent(panels.input, "keydown", handleCtrlYZ);
            util.addEvent(panels.input, "keydown", handleModeChange);
            util.addEvent(panels.input, "mousedown", function () {
                setMode("moving");
            });

            panels.input.onpaste = handlePaste;
            panels.input.ondrop = handlePaste;
        };

        var init = function () {
            setEventHandlers();
            refreshState(true);
            saveState();
        };

        init();
    }

    // end of UndoManager

    // The input textarea state/contents.
    // This is used to implement undo/redo by the undo manager.
    function TextareaState(panels, isInitialState) {

        // Aliases
        var stateObj = this;
        var inputArea = panels.input;
        this.init = function () {
            if (!util.isVisible(inputArea)) {
                return;
            }
            if (!isInitialState && doc.activeElement && doc.activeElement !== inputArea) { // this happens when tabbing out of the input box
                return;
            }

            this.setInputAreaSelectionStartEnd();
            this.scrollTop = inputArea.scrollTop;
            if (!this.text && inputArea.selectionStart || inputArea.selectionStart === 0) {
                this.text = inputArea.value;
            }

        }

        // Sets the selected text in the input box after we've performed an
        // operation.
        this.setInputAreaSelection = function () {

            if (!util.isVisible(inputArea)) {
                return;
            }

            if (inputArea.selectionStart !== undefined && !uaSniffed.isOpera) {

                inputArea.focus();
                inputArea.selectionStart = stateObj.start;
                inputArea.selectionEnd = stateObj.end;
                inputArea.scrollTop = stateObj.scrollTop;
            }
            else if (doc.selection) {

                if (doc.activeElement && doc.activeElement !== inputArea) {
                    return;
                }

                inputArea.focus();
                var range = inputArea.createTextRange();
                range.moveStart("character", -inputArea.value.length);
                range.moveEnd("character", -inputArea.value.length);
                range.moveEnd("character", stateObj.end);
                range.moveStart("character", stateObj.start);
                range.select();
            }
        };

        this.setInputAreaSelectionStartEnd = function () {

            if (!panels.ieCachedRange && (inputArea.selectionStart || inputArea.selectionStart === 0)) {

                stateObj.start = inputArea.selectionStart;
                stateObj.end = inputArea.selectionEnd;
            }
            else if (doc.selection) {

                stateObj.text = util.fixEolChars(inputArea.value);

                // IE loses the selection in the textarea when buttons are
                // clicked.  On IE we cache the selection. Here, if something is cached,
                // we take it.
                var range = panels.ieCachedRange || doc.selection.createRange();

                var fixedRange = util.fixEolChars(range.text);
                var marker = "\x07";
                var markedRange = marker + fixedRange + marker;
                range.text = markedRange;
                var inputText = util.fixEolChars(inputArea.value);

                range.moveStart("character", -markedRange.length);
                range.text = fixedRange;

                stateObj.start = inputText.indexOf(marker);
                stateObj.end = inputText.lastIndexOf(marker) - marker.length;

                var len = stateObj.text.length - util.fixEolChars(inputArea.value).length;

                if (len) {
                    range.moveStart("character", -fixedRange.length);
                    while (len--) {
                        fixedRange += "\n";
                        stateObj.end += 1;
                    }
                    range.text = fixedRange;
                }

                if (panels.ieCachedRange)
                    stateObj.scrollTop = panels.ieCachedScrollTop; // this is set alongside with ieCachedRange
                
                panels.ieCachedRange = null;

                this.setInputAreaSelection();
            }
        };

        // Restore this state into the input area.
        this.restore = function () {

            if (stateObj.text != undefined && stateObj.text != inputArea.value) {
                inputArea.value = stateObj.text;
            }
            this.setInputAreaSelection();
            inputArea.scrollTop = stateObj.scrollTop;
        };

        // Gets a collection of HTML chunks from the inptut textarea.
        this.getChunks = function () {

            var chunk = new Chunks();
            chunk.before = util.fixEolChars(stateObj.text.substring(0, stateObj.start));
            chunk.startTag = "";
            chunk.selection = util.fixEolChars(stateObj.text.substring(stateObj.start, stateObj.end));
            chunk.endTag = "";
            chunk.after = util.fixEolChars(stateObj.text.substring(stateObj.end));
            chunk.scrollTop = stateObj.scrollTop;

            return chunk;
        };

        // Sets the TextareaState properties given a chunk of markdown.
        this.setChunks = function (chunk) {

            chunk.before = chunk.before + chunk.startTag;
            chunk.after = chunk.endTag + chunk.after;

            this.start = chunk.before.length;
            this.end = chunk.before.length + chunk.selection.length;
            this.text = chunk.before + chunk.selection + chunk.after;
            this.scrollTop = chunk.scrollTop;
        };
        this.init();
    };

    function PreviewManager(converter, panels, previewRefreshCallback) {

        var managerObj = this;
        var timeout;
        var elapsedTime;
        var oldInputText;
        var maxDelay = 3000;
        var startType = "delayed"; // The other legal value is "manual"

        // Adds event listeners to elements
        var setupEvents = function (inputElem, listener) {

            util.addEvent(inputElem, "input", listener);
            inputElem.onpaste = listener;
            inputElem.ondrop = listener;

            util.addEvent(inputElem, "keypress", listener);
            util.addEvent(inputElem, "keydown", listener);
        };

        var getDocScrollTop = function () {

            var result = 0;

            if (window.innerHeight) {
                result = window.pageYOffset;
            }
            else
                if (doc.documentElement && doc.documentElement.scrollTop) {
                    result = doc.documentElement.scrollTop;
                }
                else
                    if (doc.body) {
                        result = doc.body.scrollTop;
                    }

            return result;
        };

        var makePreviewHtml = function () {

            // If there is no registered preview panel
            // there is nothing to do.
            if (!panels.preview)
                return;


            var text = panels.input.value;
            if (text && text == oldInputText) {
                return; // Input text hasn't changed.
            }
            else {
                oldInputText = text;
            }

            var prevTime = new Date().getTime();

            text = converter.makeHtml(text);

            // Calculate the processing time of the HTML creation.
            // It's used as the delay time in the event listener.
            var currTime = new Date().getTime();
            elapsedTime = currTime - prevTime;

            pushPreviewHtml(text);
        };

        // setTimeout is already used.  Used as an event listener.
        var applyTimeout = function () {

            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }

            if (startType !== "manual") {

                var delay = 0;

                if (startType === "delayed") {
                    delay = elapsedTime;
                }

                if (delay > maxDelay) {
                    delay = maxDelay;
                }
                timeout = setTimeout(makePreviewHtml, delay);
            }
        };

        var getScaleFactor = function (panel) {
            if (panel.scrollHeight <= panel.clientHeight) {
                return 1;
            }
            return panel.scrollTop / (panel.scrollHeight - panel.clientHeight);
        };

        var setPanelScrollTops = function () {
            if (panels.preview) {
                panels.preview.scrollTop = (panels.preview.scrollHeight - panels.preview.clientHeight) * getScaleFactor(panels.preview);
            }
        };

        this.refresh = function (requiresRefresh) {

            if (requiresRefresh) {
                oldInputText = "";
                makePreviewHtml();
            }
            else {
                applyTimeout();
            }
        };

        this.processingTime = function () {
            return elapsedTime;
        };

        var isFirstTimeFilled = true;

        // IE doesn't let you use innerHTML if the element is contained somewhere in a table
        // (which is the case for inline editing) -- in that case, detach the element, set the
        // value, and reattach. Yes, that *is* ridiculous.
        var ieSafePreviewSet = function (text) {
            var preview = panels.preview;
            var parent = preview.parentNode;
            var sibling = preview.nextSibling;
            parent.removeChild(preview);
            preview.innerHTML = text;
            if (!sibling)
                parent.appendChild(preview);
            else
                parent.insertBefore(preview, sibling);
        }

        var nonSuckyBrowserPreviewSet = function (text) {
            panels.preview.innerHTML = text;
        }

        var previewSetter;

        var previewSet = function (text) {
            if (previewSetter)
                return previewSetter(text);

            try {
                nonSuckyBrowserPreviewSet(text);
                previewSetter = nonSuckyBrowserPreviewSet;
            } catch (e) {
                previewSetter = ieSafePreviewSet;
                previewSetter(text);
            }
        };

        var pushPreviewHtml = function (text) {

            var emptyTop = position.getTop(panels.input) - getDocScrollTop();

            if (panels.preview) {
                previewSet(text);
                previewRefreshCallback();
            }

            setPanelScrollTops();

            if (isFirstTimeFilled) {
                isFirstTimeFilled = false;
                return;
            }

            var fullTop = position.getTop(panels.input) - getDocScrollTop();

            if (uaSniffed.isIE) {
                setTimeout(function () {
                    window.scrollBy(0, fullTop - emptyTop);
                }, 0);
            }
            else {
                window.scrollBy(0, fullTop - emptyTop);
            }
        };

        var init = function () {

            setupEvents(panels.input, applyTimeout);
            makePreviewHtml();

            if (panels.preview) {
                panels.preview.scrollTop = 0;
            }
        };

        init();
    };

    
    // This simulates a modal dialog box and asks for the URL when you
    // click the hyperlink or image buttons.
    //
    // text: The html for the input box.
    // defaultInputText: The default value that appears in the input box.
    // callback: The function which is executed when the prompt is dismissed, either via OK or Cancel.
    //      It receives a single argument; either the entered text (if OK was chosen) or null (if Cancel
    //      was chosen).
    ui.prompt = function (title, text, defaultInputText, callback) {

        // These variables need to be declared at this level since they are used
        // in multiple functions.
        var dialog;         // The dialog box.
        var input;         // The text box where you enter the hyperlink.


        if (defaultInputText === undefined) {
            defaultInputText = "";
        }

        // Used as a keydown event handler. Esc dismisses the prompt.
        // Key code 27 is ESC.
        var checkEscape = function (key) {
            var code = (key.charCode || key.keyCode);
            if (code === 27) {
                close(true);
            }
        };

        // Dismisses the hyperlink input box.
        // isCancel is true if we don't care about the input text.
        // isCancel is false if we are going to keep the text.
        var close = function (isCancel) {
            util.removeEvent(doc.body, "keydown", checkEscape);
            var text = input.value;

            if (isCancel) {
                text = null;
            }
            else {
                // Fixes common pasting errors.
                text = text.replace(/^http:\/\/(https?|ftp):\/\//, '$1://');
                if (!/^(?:https?|ftp):\/\//.test(text))
                    text = 'http://' + text;
            }

            $(dialog).modal('hide');

            callback(text);
            return false;
        };



        // Create the text input box form/window.
        var createDialog = function () {
            // <div class="modal" id="myModal">
            //   <div class="modal-header">
            //     <a class="close" data-dismiss="modal">×</a>
            //     <h3>Modal header</h3>
            //   </div>
            //   <div class="modal-body">
            //     <p>One fine body…</p>
            //   </div>
            //   <div class="modal-footer">
            //     <a href="#" class="btn btn-primary">Save changes</a>
            //     <a href="#" class="btn">Close</a>
            //   </div>
            // </div>

            // The main dialog box.
            dialog = doc.createElement("div");
            dialog.className = "fade modal linkmodal quanto-modal-v2";

            dialog_container = doc.createElement('div');
            dialog_container.className = "modal-dialog"
            dialog.appendChild(dialog_container);

            x_out_container = doc.createElement('div');
            x_out_container.className = "modal-x-out"
            dialog_container.appendChild(x_out_container);

            content_container = doc.createElement('div');
            content_container.className = "modal-content"
            dialog_container.appendChild(content_container);
            //dialog.style.display = "none";

            // The header.
            var header = doc.createElement("div");
            header.className = "modal-header";
            header.innerHTML = title;
            content_container.appendChild(header);

            // The body.
            var body = doc.createElement("div");
            body.className = "modal-body";
            content_container.appendChild(body);

            // The web form container for the text box and buttons.
            var form = doc.createElement("form"),
                style = form.style;
            form.className = 'quanto-form-v2'
            form.onsubmit = function () { return close(false); };
            style.padding = "0";
            style.margin = "0";
            body.appendChild(form);

            var formGroup = doc.createElement("div");
            formGroup.className = "form-group";
            form.appendChild(formGroup);

            // The input text box
            input = doc.createElement("input");
            input.className = 'form-control';
            input.type = "text";
            input.value = defaultInputText;
            style = input.style;
            style.display = "block";
            //style.width = "80%";
            //style.marginLeft = style.marginRight = "auto";
            formGroup.appendChild(input);

            // The insert button
            button_wrapper = doc.createElement('div');
            button_wrapper.className = "pull-right"
            var insertButton = doc.createElement("button");
            insertButton.className = "btn-v2 blue insert-button";
            insertButton.type = "button";
            insertButton.onclick = function () { return close(false); };
            insertButton.innerHTML = "Insert";

            button_wrapper.appendChild(insertButton)

            form.appendChild(button_wrapper);

            // Clear from float
            clear = doc.createElement('div');
            clear.className = "clear"
            form.appendChild(clear);

            util.addEvent(doc.body, "keydown", checkEscape);

            doc.body.appendChild(dialog);

        };

        // Why is this in a zero-length timeout?
        // Is it working around a browser bug?
        setTimeout(function () {

            createDialog();

            var defTextLen = defaultInputText.length;
            if (input.selectionStart !== undefined) {
                input.selectionStart = 0;
                input.selectionEnd = defTextLen;
            }
            else if (input.createTextRange) {
                var range = input.createTextRange();
                range.collapse(false);
                range.moveStart("character", -defTextLen);
                range.moveEnd("character", defTextLen);
                range.select();
            }
            
            $(dialog).on('shown', function () {
                input.focus();
            })
            
            $(dialog).on('hidden', function () {
                dialog.parentNode.removeChild(dialog);
            })

            $(dialog).modal('show')

            // QUANTOPIAN ADDED: attempt to set focus on input box
            setTimeout(function() { input.focus(); }, 100);
        }, 0);
    };

    function UIManager(postfix, panels, undoManager, previewManager, commandManager, helpOptions) {

        var inputBox = panels.input,
            buttons = {}; // buttons.undo, buttons.link, etc. The actual DOM elements.

        makeSpritedButtonRow(panels);

        var keyEvent = "keydown";
        if (uaSniffed.isOpera) {
            keyEvent = "keypress";
        }

        util.addEvent(inputBox, keyEvent, function (key) {

            // Check to see if we have a button key and, if so execute the callback.
            if ((key.ctrlKey || key.metaKey) && !key.altKey && !key.shiftKey) {

                var keyCode = key.charCode || key.keyCode;
                var keyCodeStr = String.fromCharCode(keyCode).toLowerCase();

                switch (keyCodeStr) {
                    case "b":
                        doClick(buttons.bold);
                        break;
                    case "i":
                        doClick(buttons.italic);
                        break;
                    case "l":
                        doClick(buttons.link);
                        break;
                    case "q":
                        doClick(buttons.quote);
                        break;
                    case "k":
                        doClick(buttons.code);
                        break;
                    // case "g":
                    //     doClick(buttons.image);
                    //     break;
                    case "o":
                        doClick(buttons.olist);
                        break;
                    case "u":
                        doClick(buttons.ulist);
                        break;
                    // case "h":
                    //     doClick(buttons.heading);
                    //     break;
                    // case "r":
                    //     doClick(buttons.hr);
                    //     break;
                    case "y":
                        doClick(buttons.redo);
                        break;
                    case "z":
                        if (key.shiftKey) {
                            doClick(buttons.redo);
                        }
                        else {
                            doClick(buttons.undo);
                        }
                        break;
                    default:
                        return;
                }


                if (key.preventDefault) {
                    key.preventDefault();
                }

                if (window.event) {
                    window.event.returnValue = false;
                }
            }
        });

        // Auto-indent on shift-enter
        util.addEvent(inputBox, "keyup", function (key) {
            if (key.shiftKey && !key.ctrlKey && !key.metaKey) {
                var keyCode = key.charCode || key.keyCode;
                // Character 13 is Enter
                if (keyCode === 13) {
                    var fakeButton = {};
                    fakeButton.textOp = bindCommand("doAutoindent");
                    doClick(fakeButton);
                }
            }
        });

        // special handler because IE clears the context of the textbox on ESC
        if (uaSniffed.isIE) {
            util.addEvent(inputBox, "keydown", function (key) {
                var code = key.keyCode;
                if (code === 27) {
                    return false;
                }
            });
        }


        // Perform the button's action.
        function doClick(button) {

            inputBox.focus();

            if (button.textOp) {

                if (undoManager) {
                    undoManager.setCommandMode();
                }

                var state = new TextareaState(panels);

                if (!state) {
                    return;
                }

                var chunks = state.getChunks();

                // Some commands launch a "modal" prompt dialog.  Javascript
                // can't really make a modal dialog box and the WMD code
                // will continue to execute while the dialog is displayed.
                // This prevents the dialog pattern I'm used to and means
                // I can't do something like this:
                //
                // var link = CreateLinkDialog();
                // makeMarkdownLink(link);
                // 
                // Instead of this straightforward method of handling a
                // dialog I have to pass any code which would execute
                // after the dialog is dismissed (e.g. link creation)
                // in a function parameter.
                //
                // Yes this is awkward and I think it sucks, but there's
                // no real workaround.  Only the image and link code
                // create dialogs and require the function pointers.
                var fixupInputArea = function () {

                    inputBox.focus();

                    if (chunks) {
                        state.setChunks(chunks);
                    }

                    state.restore();
                    previewManager.refresh();
                };

                var noCleanup = button.textOp(chunks, fixupInputArea);

                if (!noCleanup) {
                    fixupInputArea();
                }

            }

            if (button.execute) {
                button.execute(undoManager);
            }
        };

        function setupButton(button, isEnabled) {

            if (isEnabled) {
                button.disabled = false;

                if (!button.isHelp) {
                    button.onclick = function () {
                        if (this.onmouseout) {
                            this.onmouseout();
                        }
                        doClick(this);
                        return false;
                    }
                }
            }
            else {
                button.disabled = true;

                // when disabling a button, make sure we hide its tooltip if it's showing
                //$(button).tooltip('hide')
            }
        }

        function bindCommand(method) {
            if (typeof method === "string")
                method = commandManager[method];
            return function () { method.apply(commandManager, arguments); }
        }

        function makeSpritedButtonRow(panels) {

            var buttonBar = panels.buttonBar;
            var buttonRow = document.createElement("div");
            buttonRow.id = "wmd-button-row" + postfix;
            buttonRow.className = 'btn-toolbar';
            buttonRow = buttonBar.appendChild(buttonRow);

            var makeButton = function (name, textOp, group) {
                var button = document.createElement("button");
                button.className = "btn " + name;
                button.id = name + postfix;
                if (textOp)
                    button.textOp = textOp;
                setupButton(button, true);
                if (group) {
                    group.appendChild(button);
                } else {
                    buttonRow.appendChild(button);
                }
                return button;
            };

            var makeGroup = function (num) {
                var group = document.createElement("div");
                group.className = "btn-group wmd-button-group" + num;
                group.id = "wmd-button-group" + num + postfix;
                buttonRow.appendChild(group);
                return group
            }

            group1 = makeGroup(1);
            buttons.bold = makeButton("wmd-bold-button", bindCommand("doBold"), group1);
            buttons.italic = makeButton("wmd-italic-button", bindCommand("doItalic"), group1);
            
            group2 = makeGroup(2);
            buttons.link = makeButton("wmd-link-button", bindCommand(function (chunk, postProcessing) {
                return this.doLinkOrImage(chunk, postProcessing, false);
            }), group2);
            buttons.code = makeButton("wmd-code-button", bindCommand("doCode"), group2);
            buttons.quote = makeButton("wmd-quote-button", bindCommand("doBlockquote"), group2);
 
            group3 = makeGroup(3);
            buttons.olist = makeButton("wmd-olist-button", bindCommand(function (chunk, postProcessing) {
                this.doList(chunk, postProcessing, true);
            }), group3);
            buttons.ulist = makeButton("wmd-ulist-button", bindCommand(function (chunk, postProcessing) {
                this.doList(chunk, postProcessing, false);
            }), group3);
            
            group4 = makeGroup(4);
            buttons.undo = makeButton("wmd-undo-button", null, group4);
            buttons.undo.execute = function (manager) { if (manager) manager.undo(); };

            buttons.redo = makeButton("wmd-redo-button", null, group4);
            buttons.redo.execute = function (manager) { if (manager) manager.redo(); };

            group5 = makeGroup("-add-backtest");
            $(panels.buttonBar).find(".wmd-button-group-add-backtest")
                .append(
                    '<form class="quanto-form-v2" id="attachment-form">' +
                        '<div class="form-group">' +
                            '<select class="form-control attach-button" id="attachment-select" title="Attach" >' +
                                '<option>Backtest</option>' +
                                '<option>Notebook</option>' +
                            '</select>' +
                        '</div>' +
                    '</form>'
                )

            setUndoRedoButtonStates();
        }

        function setUndoRedoButtonStates() {
            if (undoManager) {
                setupButton(buttons.undo, undoManager.canUndo());
                setupButton(buttons.redo, undoManager.canRedo());
            }
        };

        this.setUndoRedoButtonStates = setUndoRedoButtonStates;

    }

    function CommandManager(pluginHooks) {
        this.hooks = pluginHooks;
    }

    var commandProto = CommandManager.prototype;

    // The markdown symbols - 4 spaces = code, > = blockquote, etc.
    commandProto.prefixes = "(?:\\s{4,}|\\s*>|\\s*-\\s+|\\s*\\d+\\.|=|\\+|-|_|\\*|#|\\s*\\[[^\n]]+\\]:)";

    // Remove markdown symbols from the chunk selection.
    commandProto.unwrap = function (chunk) {
        var txt = new re("([^\\n])\\n(?!(\\n|" + this.prefixes + "))", "g");
        chunk.selection = chunk.selection.replace(txt, "$1 $2");
    };

    commandProto.wrap = function (chunk, len) {
        this.unwrap(chunk);
        var regex = new re("(.{1," + len + "})( +|$\\n?)", "gm"),
            that = this;

        chunk.selection = chunk.selection.replace(regex, function (line, marked) {
            if (new re("^" + that.prefixes, "").test(line)) {
                return line;
            }
            return marked + "\n";
        });

        chunk.selection = chunk.selection.replace(/\s+$/, "");
    };

    commandProto.doBold = function (chunk, postProcessing) {
        return this.doBorI(chunk, postProcessing, 2, "strong text");
    };

    commandProto.doItalic = function (chunk, postProcessing) {
        return this.doBorI(chunk, postProcessing, 1, "emphasized text");
    };

    // chunk: The selected region that will be enclosed with */**
    // nStars: 1 for italics, 2 for bold
    // insertText: If you just click the button without highlighting text, this gets inserted
    commandProto.doBorI = function (chunk, postProcessing, nStars, insertText) {

        // Get rid of whitespace and fixup newlines.
        chunk.trimWhitespace();
        chunk.selection = chunk.selection.replace(/\n{2,}/g, "\n");

        // Look for stars before and after.  Is the chunk already marked up?
        // note that these regex matches cannot fail
        var starsBefore = /(\**$)/.exec(chunk.before)[0];
        var starsAfter = /(^\**)/.exec(chunk.after)[0];

        var prevStars = Math.min(starsBefore.length, starsAfter.length);

        // Remove stars if we have to since the button acts as a toggle.
        if ((prevStars >= nStars) && (prevStars != 2 || nStars != 1)) {
            chunk.before = chunk.before.replace(re("[*]{" + nStars + "}$", ""), "");
            chunk.after = chunk.after.replace(re("^[*]{" + nStars + "}", ""), "");
        }
        else if (!chunk.selection && starsAfter) {
            // It's not really clear why this code is necessary.  It just moves
            // some arbitrary stuff around.
            chunk.after = chunk.after.replace(/^([*_]*)/, "");
            chunk.before = chunk.before.replace(/(\s?)$/, "");
            var whitespace = re.$1;
            chunk.before = chunk.before + starsAfter + whitespace;
        }
        else {

            // In most cases, if you don't have any selected text and click the button
            // you'll get a selected, marked up region with the default text inserted.
            if (!chunk.selection && !starsAfter) {
                chunk.selection = insertText;
            }

            // Add the true markup.
            var markup = nStars <= 1 ? "*" : "**"; // shouldn't the test be = ?
            chunk.before = chunk.before + markup;
            chunk.after = markup + chunk.after;
        }

        return;
    };

    commandProto.stripLinkDefs = function (text, defsToAdd) {

        text = text.replace(/^[ ]{0,3}\[(\d+)\]:[ \t]*\n?[ \t]*<?(\S+?)>?[ \t]*\n?[ \t]*(?:(\n*)["(](.+?)[")][ \t]*)?(?:\n+|$)/gm,
            function (totalMatch, id, link, newlines, title) {
                defsToAdd[id] = totalMatch.replace(/\s*$/, "");
                if (newlines) {
                    // Strip the title and return that separately.
                    defsToAdd[id] = totalMatch.replace(/["(](.+?)[")]$/, "");
                    return newlines + title;
                }
                return "";
            });

        return text;
    };

    commandProto.addLinkDef = function (chunk, linkDef) {

        var refNumber = 0; // The current reference number
        var defsToAdd = {}; //
        // Start with a clean slate by removing all previous link definitions.
        chunk.before = this.stripLinkDefs(chunk.before, defsToAdd);
        chunk.selection = this.stripLinkDefs(chunk.selection, defsToAdd);
        chunk.after = this.stripLinkDefs(chunk.after, defsToAdd);

        var defs = "";
        var regex = /(\[)((?:\[[^\]]*\]|[^\[\]])*)(\][ ]?(?:\n[ ]*)?\[)(\d+)(\])/g;

        var addDefNumber = function (def) {
            refNumber++;
            def = def.replace(/^[ ]{0,3}\[(\d+)\]:/, "  [" + refNumber + "]:");
            defs += "\n" + def;
        };

        // note that
        // a) the recursive call to getLink cannot go infinite, because by definition
        //    of regex, inner is always a proper substring of wholeMatch, and
        // b) more than one level of nesting is neither supported by the regex
        //    nor making a lot of sense (the only use case for nesting is a linked image)
        var getLink = function (wholeMatch, before, inner, afterInner, id, end) {
            inner = inner.replace(regex, getLink);
            if (defsToAdd[id]) {
                addDefNumber(defsToAdd[id]);
                return before + inner + afterInner + refNumber + end;
            }
            return wholeMatch;
        };

        chunk.before = chunk.before.replace(regex, getLink);

        if (linkDef) {
            addDefNumber(linkDef);
        }
        else {
            chunk.selection = chunk.selection.replace(regex, getLink);
        }

        var refOut = refNumber;

        chunk.after = chunk.after.replace(regex, getLink);

        if (chunk.after) {
            chunk.after = chunk.after.replace(/\n*$/, "");
        }
        if (!chunk.after) {
            chunk.selection = chunk.selection.replace(/\n*$/, "");
        }

        chunk.after += "\n\n" + defs;

        return refOut;
    };

    // takes the line as entered into the add link/as image dialog and makes
    // sure the URL and the optinal title are "nice".
    function properlyEncoded(linkdef) {
        return linkdef.replace(/^\s*(.*?)(?:\s+"(.+)")?\s*$/, function (wholematch, link, title) {
            link = link.replace(/\?.*$/, function (querypart) {
                return querypart.replace(/\+/g, " "); // in the query string, a plus and a space are identical
            });
            link = decodeURIComponent(link); // unencode first, to prevent double encoding
            link = encodeURI(link).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
            link = link.replace(/\?.*$/, function (querypart) {
                return querypart.replace(/\+/g, "%2b"); // since we replaced plus with spaces in the query part, all pluses that now appear where originally encoded
            });
            if (title) {
                title = title.trim ? title.trim() : title.replace(/^\s*/, "").replace(/\s*$/, "");
                title = $.trim(title).replace(/"/g, "quot;").replace(/\(/g, "&#40;").replace(/\)/g, "&#41;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            }
            return title ? link + ' "' + title + '"' : link;
        });
    }

    commandProto.doLinkOrImage = function (chunk, postProcessing, isImage) {

        chunk.trimWhitespace();
        chunk.findTags(/\s*!?\[/, /\][ ]?(?:\n[ ]*)?(\[.*?\])?/);
        var background;

        if (chunk.endTag.length > 1 && chunk.startTag.length > 0) {

            chunk.startTag = chunk.startTag.replace(/!?\[/, "");
            chunk.endTag = "";
            this.addLinkDef(chunk, null);

        }
        else {
            
            // We're moving start and end tag back into the selection, since (as we're in the else block) we're not
            // *removing* a link, but *adding* one, so whatever findTags() found is now back to being part of the
            // link text. linkEnteredCallback takes care of escaping any brackets.
            chunk.selection = chunk.startTag + chunk.selection + chunk.endTag;
            chunk.startTag = chunk.endTag = "";

            if (/\n\n/.test(chunk.selection)) {
                this.addLinkDef(chunk, null);
                return;
            }
            var that = this;
            // The function to be executed when you enter a link and press OK or Cancel.
            // Marks up the link and adds the ref.
            var linkEnteredCallback = function (link) {

                if (link !== null) {
                    // (                          $1
                    //     [^\\]                  anything that's not a backslash
                    //     (?:\\\\)*              an even number (this includes zero) of backslashes
                    // )
                    // (?=                        followed by
                    //     [[\]]                  an opening or closing bracket
                    // )
                    //
                    // In other words, a non-escaped bracket. These have to be escaped now to make sure they
                    // don't count as the end of the link or similar.
                    // Note that the actual bracket has to be a lookahead, because (in case of to subsequent brackets),
                    // the bracket in one match may be the "not a backslash" character in the next match, so it
                    // should not be consumed by the first match.
                    // The "prepend a space and finally remove it" steps makes sure there is a "not a backslash" at the
                    // start of the string, so this also works if the selection begins with a bracket. We cannot solve
                    // this by anchoring with ^, because in the case that the selection starts with two brackets, this
                    // would mean a zero-width match at the start. Since zero-width matches advance the string position,
                    // the first bracket could then not act as the "not a backslash" for the second.
                    chunk.selection = (" " + chunk.selection).replace(/([^\\](?:\\\\)*)(?=[[\]])/g, "$1\\").substr(1);
                    
                    var linkDef = " [999]: " + properlyEncoded(link);

                    var num = that.addLinkDef(chunk, linkDef);
                    chunk.startTag = isImage ? "![" : "[";
                    chunk.endTag = "][" + num + "]";

                    if (!chunk.selection) {
                        if (isImage) {
                            chunk.selection = "enter image description here";
                        }
                        else {
                            chunk.selection = "enter link description here";
                        }
                    }
                }
                postProcessing();
            };


            if (isImage) {
                if (!this.hooks.insertImageDialog(linkEnteredCallback))
                    ui.prompt('Insert Image', imageDialogText, imageDefaultText, linkEnteredCallback);
            }
            else {
                ui.prompt('Insert Link', linkDialogText, linkDefaultText, linkEnteredCallback);
            }
            return true;
        }
    };

    // When making a list, hitting shift-enter will put your cursor on the next line
    // at the current indent level.
    commandProto.doAutoindent = function (chunk, postProcessing) {

        var commandMgr = this,
            fakeSelection = false;

        chunk.before = chunk.before.replace(/(\n|^)[ ]{0,3}([*+-]|\d+[.])[ \t]*\n$/, "\n\n");
        chunk.before = chunk.before.replace(/(\n|^)[ ]{0,3}>[ \t]*\n$/, "\n\n");
        chunk.before = chunk.before.replace(/(\n|^)[ \t]+\n$/, "\n\n");
        
        // There's no selection, end the cursor wasn't at the end of the line:
        // The user wants to split the current list item / code line / blockquote line
        // (for the latter it doesn't really matter) in two. Temporarily select the
        // (rest of the) line to achieve this.
        if (!chunk.selection && !/^[ \t]*(?:\n|$)/.test(chunk.after)) {
            chunk.after = chunk.after.replace(/^[^\n]*/, function (wholeMatch) {
                chunk.selection = wholeMatch;
                return "";
            });
            fakeSelection = true;
        }

        if (/(\n|^)[ ]{0,3}([*+-]|\d+[.])[ \t]+.*\n$/.test(chunk.before)) {
            if (commandMgr.doList) {
                commandMgr.doList(chunk);
            }
        }
        if (/(\n|^)[ ]{0,3}>[ \t]+.*\n$/.test(chunk.before)) {
            if (commandMgr.doBlockquote) {
                commandMgr.doBlockquote(chunk);
            }
        }
        if (/(\n|^)(\t|[ ]{4,}).*\n$/.test(chunk.before)) {
            if (commandMgr.doCode) {
                commandMgr.doCode(chunk);
            }
        }
        
        if (fakeSelection) {
            chunk.after = chunk.selection + chunk.after;
            chunk.selection = "";
        }
    };

    commandProto.doBlockquote = function (chunk, postProcessing) {

        chunk.selection = chunk.selection.replace(/^(\n*)([^\r]+?)(\n*)$/,
            function (totalMatch, newlinesBefore, text, newlinesAfter) {
                chunk.before += newlinesBefore;
                chunk.after = newlinesAfter + chunk.after;
                return text;
            });

        chunk.before = chunk.before.replace(/(>[ \t]*)$/,
            function (totalMatch, blankLine) {
                chunk.selection = blankLine + chunk.selection;
                return "";
            });

        chunk.selection = chunk.selection.replace(/^(\s|>)+$/, "");
        chunk.selection = chunk.selection || "Blockquote";

        // The original code uses a regular expression to find out how much of the
        // text *directly before* the selection already was a blockquote:

        /*
        if (chunk.before) {
        chunk.before = chunk.before.replace(/\n?$/, "\n");
        }
        chunk.before = chunk.before.replace(/(((\n|^)(\n[ \t]*)*>(.+\n)*.*)+(\n[ \t]*)*$)/,
        function (totalMatch) {
        chunk.startTag = totalMatch;
        return "";
        });
        */

        // This comes down to:
        // Go backwards as many lines a possible, such that each line
        //  a) starts with ">", or
        //  b) is almost empty, except for whitespace, or
        //  c) is preceeded by an unbroken chain of non-empty lines
        //     leading up to a line that starts with ">" and at least one more character
        // and in addition
        //  d) at least one line fulfills a)
        //
        // Since this is essentially a backwards-moving regex, it's susceptible to
        // catstrophic backtracking and can cause the browser to hang;
        // see e.g. http://meta.stackoverflow.com/questions/9807.
        //
        // Hence we replaced this by a simple state machine that just goes through the
        // lines and checks for a), b), and c).

        var match = "",
            leftOver = "",
            line;
        if (chunk.before) {
            var lines = chunk.before.replace(/\n$/, "").split("\n");
            var inChain = false;
            for (var i = 0; i < lines.length; i++) {
                var good = false;
                line = lines[i];
                inChain = inChain && line.length > 0; // c) any non-empty line continues the chain
                if (/^>/.test(line)) {                // a)
                    good = true;
                    if (!inChain && line.length > 1)  // c) any line that starts with ">" and has at least one more character starts the chain
                        inChain = true;
                } else if (/^[ \t]*$/.test(line)) {   // b)
                    good = true;
                } else {
                    good = inChain;                   // c) the line is not empty and does not start with ">", so it matches if and only if we're in the chain
                }
                if (good) {
                    match += line + "\n";
                } else {
                    leftOver += match + line;
                    match = "\n";
                }
            }
            if (!/(^|\n)>/.test(match)) {             // d)
                leftOver += match;
                match = "";
            }
        }

        chunk.startTag = match;
        chunk.before = leftOver;

        // end of change

        if (chunk.after) {
            chunk.after = chunk.after.replace(/^\n?/, "\n");
        }

        chunk.after = chunk.after.replace(/^(((\n|^)(\n[ \t]*)*>(.+\n)*.*)+(\n[ \t]*)*)/,
            function (totalMatch) {
                chunk.endTag = totalMatch;
                return "";
            }
        );

        var replaceBlanksInTags = function (useBracket) {

            var replacement = useBracket ? "> " : "";

            if (chunk.startTag) {
                chunk.startTag = chunk.startTag.replace(/\n((>|\s)*)\n$/,
                    function (totalMatch, markdown) {
                        return "\n" + markdown.replace(/^[ ]{0,3}>?[ \t]*$/gm, replacement) + "\n";
                    });
            }
            if (chunk.endTag) {
                chunk.endTag = chunk.endTag.replace(/^\n((>|\s)*)\n/,
                    function (totalMatch, markdown) {
                        return "\n" + markdown.replace(/^[ ]{0,3}>?[ \t]*$/gm, replacement) + "\n";
                    });
            }
        };

        if (/^(?![ ]{0,3}>)/m.test(chunk.selection)) {
            this.wrap(chunk, SETTINGS.lineLength - 2);
            chunk.selection = chunk.selection.replace(/^/gm, "> ");
            replaceBlanksInTags(true);
            chunk.skipLines();
        } else {
            chunk.selection = chunk.selection.replace(/^[ ]{0,3}> ?/gm, "");
            this.unwrap(chunk);
            replaceBlanksInTags(false);

            if (!/^(\n|^)[ ]{0,3}>/.test(chunk.selection) && chunk.startTag) {
                chunk.startTag = chunk.startTag.replace(/\n{0,2}$/, "\n\n");
            }

            if (!/(\n|^)[ ]{0,3}>.*$/.test(chunk.selection) && chunk.endTag) {
                chunk.endTag = chunk.endTag.replace(/^\n{0,2}/, "\n\n");
            }
        }

        chunk.selection = this.hooks.postBlockquoteCreation(chunk.selection);

        if (!/\n/.test(chunk.selection)) {
            chunk.selection = chunk.selection.replace(/^(> *)/,
            function (wholeMatch, blanks) {
                chunk.startTag += blanks;
                return "";
            });
        }
    };

    commandProto.doCode = function (chunk, postProcessing) {

        var hasTextBefore = /\S[ ]*$/.test(chunk.before);
        var hasTextAfter = /^[ ]*\S/.test(chunk.after);

        // QUANTOPIAN EDITED - use the ```\nchunk```\n method, because it handles newlines the best.
        if (!(_.str.endsWith(chunk.before, "```\n"))) {
            chunk.before += "```\n"
        }

        if (chunk.after.indexOf("\n```") != 0) {
            chunk.after =  "\n```" + chunk.after
        }        

        return


        // // Use 'four space' markdown if the selection is on its own
        // // line or is multiline.
        
        // if ((!hasTextAfter && !hasTextBefore) || /\n/.test(chunk.selection)) {

        //     chunk.before = chunk.before.replace(/[ ]{4}$/,
        //         function (totalMatch) {
        //             chunk.selection = totalMatch + chunk.selection;
        //             return "";
        //         });

        //     var nLinesBack = 1;
        //     var nLinesForward = 1;

        //     if (/(\n|^)(\t|[ ]{4,}).*\n$/.test(chunk.before)) {
        //         nLinesBack = 0;
        //     }
        //     if (/^\n(\t|[ ]{4,})/.test(chunk.after)) {
        //         nLinesForward = 0;
        //     }

        //     chunk.skipLines(nLinesBack, nLinesForward);

        //     if (!chunk.selection) {
        //         chunk.startTag = "    ";
        //         chunk.selection = "enter code here";
        //     }
        //     else {
        //         if (/^[ ]{0,3}\S/m.test(chunk.selection)) {
        //             if (/\n/.test(chunk.selection))
        //                 chunk.selection = chunk.selection.replace(/^/gm, "    ");
        //             else // if it's not multiline, do not select the four added spaces; this is more consistent with the doList behavior
        //                 chunk.before += "    ";
        //         }
        //         else {
        //             chunk.selection = chunk.selection.replace(/^[ ]{4}/gm, "");
        //         }
        //     }
        // }
        // else {
        //     // Use backticks (`) to delimit the code block.

        //     chunk.trimWhitespace();
        //     chunk.findTags(/`/, /`/);

        //     if (!chunk.startTag && !chunk.endTag) {
        //         chunk.startTag = chunk.endTag = "`";
        //         if (!chunk.selection) {
        //             chunk.selection = "enter code here";
        //         }
        //     }
        //     else if (chunk.endTag && !chunk.startTag) {
        //         chunk.before += chunk.endTag;
        //         chunk.endTag = "";
        //     }
        //     else {
        //         chunk.startTag = chunk.endTag = "";
        //     }
        // }
    };

    commandProto.doList = function (chunk, postProcessing, isNumberedList) {

        // These are identical except at the very beginning and end.
        // Should probably use the regex extension function to make this clearer.
        var previousItemsRegex = /(\n|^)(([ ]{0,3}([*+-]|\d+[.])[ \t]+.*)(\n.+|\n{2,}([*+-].*|\d+[.])[ \t]+.*|\n{2,}[ \t]+\S.*)*)\n*$/;
        var nextItemsRegex = /^\n*(([ ]{0,3}([*+-]|\d+[.])[ \t]+.*)(\n.+|\n{2,}([*+-].*|\d+[.])[ \t]+.*|\n{2,}[ \t]+\S.*)*)\n*/;

        // The default bullet is a dash but others are possible.
        // This has nothing to do with the particular HTML bullet,
        // it's just a markdown bullet.
        var bullet = "-";

        // The number in a numbered list.
        var num = 1;

        // Get the item prefix - e.g. " 1. " for a numbered list, " - " for a bulleted list.
        var getItemPrefix = function () {
            var prefix;
            if (isNumberedList) {
                prefix = " " + num + ". ";
                num++;
            }
            else {
                prefix = " " + bullet + " ";
            }
            return prefix;
        };

        // Fixes the prefixes of the other list items.
        var getPrefixedItem = function (itemText) {

            // The numbering flag is unset when called by autoindent.
            if (isNumberedList === undefined) {
                isNumberedList = /^\s*\d/.test(itemText);
            }

            // Renumber/bullet the list element.
            itemText = itemText.replace(/^[ ]{0,3}([*+-]|\d+[.])\s/gm,
                function (_) {
                    return getItemPrefix();
                });

            return itemText;
        };

        chunk.findTags(/(\n|^)*[ ]{0,3}([*+-]|\d+[.])\s+/, null);

        if (chunk.before && !/\n$/.test(chunk.before) && !/^\n/.test(chunk.startTag)) {
            chunk.before += chunk.startTag;
            chunk.startTag = "";
        }

        if (chunk.startTag) {

            var hasDigits = /\d+[.]/.test(chunk.startTag);
            chunk.startTag = "";
            chunk.selection = chunk.selection.replace(/\n[ ]{4}/g, "\n");
            this.unwrap(chunk);
            chunk.skipLines();

            if (hasDigits) {
                // Have to renumber the bullet points if this is a numbered list.
                chunk.after = chunk.after.replace(nextItemsRegex, getPrefixedItem);
            }
            if (isNumberedList == hasDigits) {
                return;
            }
        }

        var nLinesUp = 1;

        chunk.before = chunk.before.replace(previousItemsRegex,
            function (itemText) {
                if (/^\s*([*+-])/.test(itemText)) {
                    bullet = re.$1;
                }
                nLinesUp = /[^\n]\n\n[^\n]/.test(itemText) ? 1 : 0;
                return getPrefixedItem(itemText);
            });

        // if (!chunk.selection) {
        //     chunk.selection = "List item";
        // }

        var prefix = getItemPrefix();

        var nLinesDown = 1;

        chunk.after = chunk.after.replace(nextItemsRegex,
            function (itemText) {
                nLinesDown = /[^\n]\n\n[^\n]/.test(itemText) ? 1 : 0;
                return getPrefixedItem(itemText);
            });

        chunk.trimWhitespace(true);
        chunk.skipLines(nLinesUp, nLinesDown, true);
        chunk.startTag = prefix;
        var spaces = prefix.replace(/./g, " ");
        this.wrap(chunk, SETTINGS.lineLength - spaces.length);
        chunk.selection = chunk.selection.replace(/\n/g, "\n" + spaces);

    };

    commandProto.doHeading = function (chunk, postProcessing) {

        // Remove leading/trailing whitespace and reduce internal spaces to single spaces.
        chunk.selection = chunk.selection.replace(/\s+/g, " ");
        chunk.selection = chunk.selection.replace(/(^\s+|\s+$)/g, "");

        // If we clicked the button with no selected text, we just
        // make a level 2 hash header around some default text.
        if (!chunk.selection) {
            chunk.startTag = "## ";
            chunk.selection = "Heading";
            chunk.endTag = " ##";
            return;
        }

        var headerLevel = 0;     // The existing header level of the selected text.

        // Remove any existing hash heading markdown and save the header level.
        chunk.findTags(/#+[ ]*/, /[ ]*#+/);
        if (/#+/.test(chunk.startTag)) {
            headerLevel = re.lastMatch.length;
        }
        chunk.startTag = chunk.endTag = "";

        // Try to get the current header level by looking for - and = in the line
        // below the selection.
        chunk.findTags(null, /\s?(-+|=+)/);
        if (/=+/.test(chunk.endTag)) {
            headerLevel = 1;
        }
        if (/-+/.test(chunk.endTag)) {
            headerLevel = 2;
        }

        // Skip to the next line so we can create the header markdown.
        chunk.startTag = chunk.endTag = "";
        chunk.skipLines(1, 1);

        // We make a level 2 header if there is no current header.
        // If there is a header level, we substract one from the header level.
        // If it's already a level 1 header, it's removed.
        var headerLevelToCreate = headerLevel == 0 ? 2 : headerLevel - 1;

        if (headerLevelToCreate > 0) {

            // The button only creates level 1 and 2 underline headers.
            // Why not have it iterate over hash header levels?  Wouldn't that be easier and cleaner?
            var headerChar = headerLevelToCreate >= 2 ? "-" : "=";
            var len = chunk.selection.length;
            if (len > SETTINGS.lineLength) {
                len = SETTINGS.lineLength;
            }
            chunk.endTag = "\n";
            while (len--) {
                chunk.endTag += headerChar;
            }
        }
    };

    commandProto.doHorizontalRule = function (chunk, postProcessing) {
        chunk.startTag = "----------\n";
        chunk.selection = "";
        chunk.skipLines(2, 1, true);
    }

})();
(function () {
    var output, Converter;
    if (typeof exports === "object" && typeof require === "function") { // we're in a CommonJS (e.g. Node.js) module
        output = exports;
        Converter = require("./Markdown.Converter").Converter;
    } else {
        output = window.Markdown;
        Converter = output.Converter;
    }
        
    output.getSanitizingConverter = function () {
        var converter = new Converter();
        converter.hooks.chain("postConversion", sanitizeHtml);
        converter.hooks.chain("postConversion", balanceTags);
        return converter;
    }

    function sanitizeHtml(html) {
        return html.replace(/<[^>]*>?/gi, sanitizeTag);
    }

    // (tags that can be opened/closed) | (tags that stand alone)
    var basic_tag_whitelist = /^(<\/?(b|blockquote|code|del|dd|dl|dt|em|h1|h2|h3|i|kbd|li|ol|p|s|sup|sub|strong|strike|ul)>|<(br|hr)\s?\/?>)$/i;
    // <a href="url..." optional title>|</a>
    var a_white = /^(<a\shref="(https?:(\/\/|\/)|ftp:(\/\/|\/)|mailto:|magnet:)[-A-Za-z0-9+&@#\/%?=~_|!:,.;\(\)]+"(\stitle="[^"<>]+")?\s?>|<\/a>)$/i;

    // <img src="url..." optional width  optional height  optional alt  optional title
    var img_white = /^(<img\ssrc="(https?:\/\/|\/)[-A-Za-z0-9+&@#\/%?=~_|!:,.;\(\)]+"(\swidth="\d{1,3}")?(\sheight="\d{1,3}")?(\salt="[^"<>]*")?(\stitle="[^"<>]*")?\s?\/?>)$/i;

    // <pre optional class="prettyprint linenums">|</pre> for twitter bootstrap
    var pre_white = /^(<pre(\sclass="prettyprint linenums")?>|<\/pre>)$/i;

    function sanitizeTag(tag) {
        if (tag.match(basic_tag_whitelist) || tag.match(a_white) || tag.match(img_white) || tag.match(pre_white))
            return tag;
        else if (tag == "<div class='backtest-marker'>") {
            window.match_start = true;
            return tag;
        } else if (typeof(window.match_start) != 'undefined' && window.match_start && tag == "</div>") {
            this.match_start = false;
            return tag;
        } else
            return "";
    }

    /// <summary>
    /// attempt to balance HTML tags in the html string
    /// by removing any unmatched opening or closing tags
    /// IMPORTANT: we *assume* HTML has *already* been 
    /// sanitized and is safe/sane before balancing!
    /// 
    /// adapted from CODESNIPPET: A8591DBA-D1D3-11DE-947C-BA5556D89593
    /// </summary>
    function balanceTags(html) {

        if (html == "")
            return "";

        var re = /<\/?\w+[^>]*(\s|$|>)/g;
        // convert everything to lower case; this makes
        // our case insensitive comparisons easier
        var tags = html.toLowerCase().match(re);

        // no HTML tags present? nothing to do; exit now
        var tagcount = (tags || []).length;
        if (tagcount == 0)
            return html;

        var tagname, tag;
        var ignoredtags = "<p><img><br><li><hr>";
        var match;
        var tagpaired = [];
        var tagremove = [];
        var needsRemoval = false;

        // loop through matched tags in forward order
        for (var ctag = 0; ctag < tagcount; ctag++) {
            tagname = tags[ctag].replace(/<\/?(\w+).*/, "$1");
            // skip any already paired tags
            // and skip tags in our ignore list; assume they're self-closed
            if (tagpaired[ctag] || ignoredtags.search("<" + tagname + ">") > -1)
                continue;

            tag = tags[ctag];
            match = -1;

            if (!/^<\//.test(tag)) {
                // this is an opening tag
                // search forwards (next tags), look for closing tags
                for (var ntag = ctag + 1; ntag < tagcount; ntag++) {
                    if (!tagpaired[ntag] && tags[ntag] == "</" + tagname + ">") {
                        match = ntag;
                        break;
                    }
                }
            }

            if (match == -1)
                needsRemoval = tagremove[ctag] = true; // mark for removal
            else
                tagpaired[match] = true; // mark paired
        }

        if (!needsRemoval)
            return html;

        // delete all orphaned tags from the string

        var ctag = 0;
        html = html.replace(re, function (match) {
            var res = tagremove[ctag] ? "" : match;
            ctag++;
            return res;
        });
        return html;
    }
})();
(function() {
  var PostManagerBase,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

  quanto.PostManagerBase = PostManagerBase = (function() {
    function PostManagerBase() {
      this.get_error_msg = bind(this.get_error_msg, this);
      this.get_validation_tooltip_text = bind(this.get_validation_tooltip_text, this);
      this.get_preview_link_text = bind(this.get_preview_link_text, this);
      this.reset_path = bind(this.reset_path, this);
      this.remove_attachment = bind(this.remove_attachment, this);
      this.add_attached_backtest = bind(this.add_attached_backtest, this);
      this.preview_post = bind(this.preview_post, this);
      this.receive_iframe_message = bind(this.receive_iframe_message, this);
      this.before_submit = bind(this.before_submit, this);
      this.enable_controls = bind(this.enable_controls, this);
      this.disable_controls = bind(this.disable_controls, this);
      this.add_attached_notebook = bind(this.add_attached_notebook, this);
      this.initialize_attachments = bind(this.initialize_attachments, this);
      this.validate = bind(this.validate, this);
      this.initialize_validation = bind(this.initialize_validation, this);
      this.use_title = $("#titlebox").length > 0;
      this.submit_text = "Submit Post";
      this.submitting_text = "Submitting...";
      this.initialize_attachments();
      window.addEventListener("message", this.receive_iframe_message, false);
      this.$preview_reply_link = $(".preview-reply-link");
      quanto.on_click(".preview-reply-link", (function(_this) {
        return function(e) {
          return _this.preview_post();
        };
      })(this));
      this.$preview_link = $(".preview-post-link");
      this.initialize_validation();
    }

    PostManagerBase.prototype.initialize_validation = function() {
      this.$submit_button = $("#reply-button");
      this.tooltip_data = {
        title: this.get_validation_tooltip_text(),
        placement: "left"
      };
      $("#wmd-input").bind("input change", this.validate);
      $("#titlebox").bind("input change", this.validate);
      if (this.$submit_button.hasClass("disabled")) {
        this.$submit_button.tooltip(this.tooltip_data);
        this.$preview_link.tooltip(this.tooltip_data);
      }
      return this.validate();
    };

    PostManagerBase.prototype.validate = function() {
      var body, title;
      title = _.str.trim($("#titlebox").val());
      body = _.str.trim($("#wmd-input").val());
      if ((this.use_title && title.length === 0) || body.length === 0) {
        if (!this.$submit_button.hasClass("disabled")) {
          this.$submit_button.tooltip(this.tooltip_data);
          this.$preview_link.tooltip(this.tooltip_data);
          this.$submit_button.addClass("disabled");
          return this.$preview_link.addClass("disabled");
        }
      } else {
        this.$submit_button.tooltip('destroy');
        this.$submit_button.removeClass("disabled");
        this.$preview_link.tooltip('destroy');
        return this.$preview_link.removeClass("disabled");
      }
    };

    PostManagerBase.prototype.initialize_attachments = function() {
      var algo_title, backtest_id, backtest_title, path_pieces;
      quanto.instances.attach_backtest_manager = new quanto.AttachBacktestModalManagerVirtualized();
      quanto.instances.attach_notebook_manager = new quanto.AttachNotebookModalManager();
      $(document).bind("insert_backtest_in_reply", (function(_this) {
        return function() {
          return quanto.instances.attach_backtest_manager.show_modal();
        };
      })(this));
      $(document).bind("insert_notebook_in_reply", (function(_this) {
        return function() {
          return quanto.instances.attach_notebook_manager.show_modal();
        };
      })(this));
      this.attached_backtest_id = null;
      this.attached_backtest_template = Handlebars.compile("<div class='attachment-container'> <span class='attachment-label backtest-label'> <strong>{{backtest_name}}</strong> of <strong>{{algo_name}}</strong> </span> <span class='remove-attachment-link'> </div>");
      this.attached_notebook_template = Handlebars.compile("<div class='attachment-container'> <span class='attachment-label'> <strong>{{notebook_name}}</strong> </span> <span class='remove-attachment-link'> </div>");
      $(document).bind("attach_backtest", (function(_this) {
        return function(e, data) {
          var algo, backtest;
          algo = data["algo"];
          backtest = data["backtest"];
          _this.add_attached_backtest(backtest.id, backtest.title, algo.title, backtest.migrated_bt_id);
          return $('#backtest-id').val(backtest.id);
        };
      })(this));
      $(document).bind("attach_notebook", (function(_this) {
        return function(e, data) {
          _this.research_host_url = data.research_host_url;
          _this.attached_notebook = data.notebook;
          return _this.add_attached_notebook(_this.attached_notebook.name);
        };
      })(this));
      $(document).on("click", ".remove-attachment-link", this.remove_attachment);
      if ($("#backtest-id").length > 0 && $("#backtest-id").val() !== "") {
        this.sharing_backtest = true;
        backtest_id = $("#backtest-id").val();
        algo_title = $('#algorithm-title').val();
        backtest_title = $('#backtest-title').val();
        this.add_attached_backtest(backtest_id, backtest_title, algo_title);
      }
      if ($('#nb-preview-data').length > 0) {
        this.existing_notebook = $('#nb-preview-data').data();
        path_pieces = this.existing_notebook.notebook_path.split('/');
        return this.add_attached_notebook(path_pieces[path_pieces.length - 1]);
      }
    };

    PostManagerBase.prototype.add_attached_notebook = function(name) {
      $("#attachment-form").addClass("hidden");
      $(".wmd-button-group-add-backtest").append(this.attached_notebook_template({
        notebook_name: quanto.escapeHTML(name)
      }));
      return $('#wmd-button-group-add-backtest').find('.quanto-dropdown').hide();
    };

    PostManagerBase.prototype.disable_controls = function() {
      this.$text_editor.attr("disabled", "disabled").addClass("disabled");
      return this.$submit_button.attr("disabled", "disabled").addClass("disabled").html(this.submitting_text);
    };

    PostManagerBase.prototype.enable_controls = function() {
      this.$text_editor.attr("disabled", false).removeClass("disabled");
      return this.$submit_button.attr("disabled", false).removeClass("disabled").html(this.submit_text);
    };

    PostManagerBase.prototype.before_submit = function() {
      var data;
      if (((this.attached_notebook != null) || this.shared_from_notebook) && (this.research_host_url != null)) {
        data = {
          event: "attach_notebook"
        };
        $("#attach-notebook-modal .notebook-list-iframe")[0].contentWindow.postMessage(data, this.research_host_url);
        return this.cur_timeout_id = setTimeout((function(_this) {
          return function() {
            _this.enable_controls();
            quanto.show_error_popup("Error", "There was a problem attaching your notebook to this post.  Try again or contact us by <a href='#' class='open-feedback-link'>sending feedback</a>.");
            return _this.cur_timeout_id = null;
          };
        })(this), 60000);
      } else {
        if (this.existing_notebook != null) {
          this.post_data["keep_existing_nb"] = true;
        } else if (this.attached_backtest_id != null) {
          this.post_data["backtest_id"] = this.attached_backtest_id;
        }
        return this.finish_submit();
      }
    };

    PostManagerBase.prototype.receive_iframe_message = function(event) {
      if (this.cur_timeout_id == null) {
        return;
      }
      if (event.origin === this.research_host_url && (event.data != null)) {
        clearTimeout(this.cur_timeout_id);
        this.cur_timeout_id = null;
        if (event.data.event === "attach_notebook_succeeded") {
          this.post_data.nb_id = event.data.upload_id;
          this.post_data.nb_path = event.data.nb_path;
          return this.finish_submit();
        } else if (event.data.event === "attach_notebook_failed") {
          this.enable_controls();
          quanto.show_error_popup("Error", "There was a problem attaching your notebook to this post.  Try again or contact us by <a href='#' class='open-feedback-link'>sending feedback</a>.");
        }
      }
    };

    PostManagerBase.prototype.preview_post = function() {
      var body, data, title;
      if (this.$preview_reply_link.hasClass("disabled")) {
        return;
      }
      title = _.str.trim($("#titlebox").val());
      body = _.str.trim($("#wmd-input").val());
      if ((this.use_title && title.length === 0) || body.length === 0) {
        quanto.show_error_popup("Error", "Enter a body for this post.");
        return;
      }
      if (this.$preview_reply_link.hasClass("disabled")) {
        return;
      }
      this.$preview_reply_link.html("Generating...").addClass("disabled");
      data = {
        markdown: body,
        backtest_id: this.attached_backtest_id
      };
      return $.post("/posts/generate_preview", data, (function(_this) {
        return function(response) {
          var $data_container, $title_container, $widget, backtest_html, html, qjr, ref;
          qjr = new quanto.JsonResponse(response);
          if (qjr.ok()) {
            _this.$preview_reply_link.html(_this.get_preview_link_text()).removeClass("disabled");
            $data_container = $("#preview_reply_modal .preview-data");
            html = qjr.data()["html"];
            $data_container.html(html);
            $title_container = $("#preview_reply_modal .preview-title");
            setTimeout((function() {
              var error;
              try {
                return MathJax.Hub.Queue(["Typeset", MathJax.Hub, "preview_reply_modal"]);
              } catch (error1) {
                error = error1;
                return console.log("Could not mathjax typeset reply: " + error);
              }
            }), 100);
            if (_this.use_title) {
              $title_container.removeClass("hidden");
              title = quanto.escapeHTML($("#titlebox").val());
              if ($.trim(title).length === 0) {
                title = "(no title)";
              }
              $("#preview_reply_modal .preview-title").html(title);
            } else {
              $title_container.addClass("hidden");
            }
            $data_container.find("code").addClass("prettyprint");
            window.prettyPrint();
            $("#preview_reply_modal").modal("show");
            backtest_html = qjr.data().backtest_html;
            if (backtest_html != null) {
              $data_container.append(backtest_html);
              $widget = $data_container.find(".backtest-widget");
              setTimeout((function() {
                var mgr;
                return mgr = new quanto.BacktestSummaryManager($widget, _this.attached_backtest_id, _this.attached_backtest_migrated_id);
              }), 10);
            }
            return (ref = quanto.chart) != null ? ref.setSize(850, 300) : void 0;
          }
        };
      })(this));
    };

    PostManagerBase.prototype.add_attached_backtest = function(id, backtest_title, algo_title, migrated_bt_id) {
      if (migrated_bt_id == null) {
        migrated_bt_id = null;
      }
      this.attached_backtest_id = id;
      this.attached_backtest_migrated_id = migrated_bt_id;
      $("#attachment-form").addClass("hidden");
      $(".wmd-button-group-add-backtest").append(this.attached_backtest_template({
        backtest_name: backtest_title,
        algo_name: quanto.escapeHTML(algo_title)
      }));
      return $('#wmd-button-group-add-backtest').find('.quanto-dropdown').hide();
    };

    PostManagerBase.prototype.remove_attachment = function() {
      this.attached_notebook = null;
      this.existing_notebook = null;
      this.attached_backtest_id = null;
      this.attached_backtest_migrated_id = null;
      this.sharing_backtest = false;
      $(".attachment-container").remove();
      $("#attachment-form").removeClass("hidden");
      $("#backtest-id").val('');
      return $('#wmd-button-group-add-backtest').find('.quanto-dropdown').show();
    };

    PostManagerBase.prototype.reset_path = function() {
      return window.history.pushState({}, "", "/posts/new");
    };

    PostManagerBase.prototype.get_preview_link_text = function() {
      return "Preview Post";
    };

    PostManagerBase.prototype.get_validation_tooltip_text = function() {
      return "Enter a title and body for this post";
    };

    PostManagerBase.prototype.get_error_msg = function(response) {
      var error_code, qjr;
      if (response == null) {
        return this.error_messages["default"];
      }
      qjr = new quanto.JsonResponse(response);
      error_code = qjr.data();
      if ((error_code != null) && (this.error_messages[error_code] != null)) {
        return this.error_messages[error_code];
      }
      return this.error_messages["default"];
    };

    PostManagerBase.prototype.error_messages = {
      "saving-error": "Error saving post",
      "cannot-approve-reply": "Cannot approve reply to unsecure post.",
      "rate-limit-exceeded": "The frequency of your posts has triggered our spam filter. Please wait a little while before posting again.",
      "default": "Sorry, something went wrong.  Try again or contact us by <a class='open-feedback-link'>sending feedback</a>."
    };

    return PostManagerBase;

  })();

}).call(this);
(function() {
  var AttachBacktestModalManager,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

  quanto.AttachBacktestModalManagerVirtualized = AttachBacktestModalManager = (function() {
    function AttachBacktestModalManager() {
      this.handle_backtest_clicked = bind(this.handle_backtest_clicked, this);
      this.toggle_attach_enabled = bind(this.toggle_attach_enabled, this);
      this.handle_algo_clicked = bind(this.handle_algo_clicked, this);
      this.load_backtests = bind(this.load_backtests, this);
      this.load_algorithms = bind(this.load_algorithms, this);
      this.reset_ui = bind(this.reset_ui, this);
      this.show_modal = bind(this.show_modal, this);
      this.$modal = $("#attach-backtest-modal");
      this.$algo_select = this.$modal.find("#select-algo");
      this.$backtest_select = this.$modal.find("#select-backtest");
      this.$attach_backtest_button = this.$modal.find("#attach-backtest-button");
      this.$algo_select.change((function(_this) {
        return function(e) {
          return _this.handle_algo_clicked(e);
        };
      })(this));
      this.$backtest_select.change((function(_this) {
        return function(e) {
          return _this.handle_backtest_clicked(e);
        };
      })(this));
      $(document).on("click", "ul.dropdown-menu li", (function(_this) {
        return function(e) {
          var $target;
          $target = $(e.target);
          if ($target.closest("a").hasClass("load-more")) {
            return e.stopPropagation();
          }
        };
      })(this));
      this.$attach_backtest_button.on("click", (function(_this) {
        return function(e) {
          $(document).trigger("attach_backtest", [
            {
              "algo": _this.selected_algorithm,
              "backtest": _this.selected_backtest
            }
          ]);
          return _this.$modal.modal("hide");
        };
      })(this));
      this.reset_ui();
    }

    AttachBacktestModalManager.prototype.show_modal = function() {
      $("#attach-backtest-modal").modal("show");
      this.reset_ui();
      return this.load_algorithms(true);
    };

    AttachBacktestModalManager.prototype.reset_ui = function() {
      this.algo_page = 0;
      this.backtest_page = 0;
      this.$algo_select.html("");
      this.$backtest_select.html("");
      this.selected_algorithm = null;
      this.selected_backtest = null;
      this.loading_algorithms_lock = false;
      return this.loading_backtests_lock = false;
    };

    AttachBacktestModalManager.prototype.load_algorithms = function(initial) {
      $(".select-algo").find(".load-more span").html("Loading...");
      this.loading_algorithms_lock = true;
      return $.get("/algorithms/get_algorithm_list", {
        page: this.algo_page
      }, (function(_this) {
        return function(response) {
          var algo, data, i, len, qjr, ref;
          qjr = new quanto.JsonResponse(response);
          if (qjr.ok()) {
            _this.loading_algorithms_lock = false;
            _this.$algo_select.find(".load-more").remove();
            data = qjr.data();
            if (initial && data["algorithms"].length === 0) {
              _this.$modal.find(".no-algos").show();
            } else {
              _this.$modal.find(".loading").addClass("hidden");
              _this.$modal.find(".select-algo").removeClass("invisible");
              _this.$modal.find(".select-backtest").removeClass("invisible");
              _this.$algo_select.val("Select an algorithm").selectpicker("refresh");
              _this.$backtest_select.val("Select a backtest").selectpicker("refresh");
              _this.$modal.find(".select-backtest").addClass("disabled");
            }
            ref = data["algorithms"];
            for (i = 0, len = ref.length; i < len; i++) {
              algo = ref[i];
              _this.$algo_select.append("<option data-algo-id='" + algo.id + "'>" + (quanto.escapeHTML(algo.title)) + "</option>");
            }
            if (data["is_more"]) {
              _this.$algo_select.append("<option class='load-more'>+ Load More Algorithms</option");
            }
            if (initial) {
              return _this.$algo_select.val("Select an algorithm").selectpicker("refresh");
            } else {
              return _this.$algo_select.selectpicker("refresh");
            }
          } else {
            return _this.loading_algorithms_lock = false;
          }
        };
      })(this)).error((function(_this) {
        return function(response) {
          return _this.loading_algorithms_lock = false;
        };
      })(this));
    };

    AttachBacktestModalManager.prototype.load_backtests = function(algo_id, initial) {
      this.loading_backtests_lock = true;
      $(".select-backtest").find(".load-more span").html("Loading...");
      return $.get("/algorithms/get_backtest_list", {
        id: algo_id,
        page: this.backtest_page
      }, (function(_this) {
        return function(response) {
          var backtest, data, i, len, qjr, ref;
          qjr = new quanto.JsonResponse(response);
          if (qjr.ok()) {
            _this.loading_backtests_lock = false;
            _this.$backtest_select.find(".load-more").remove();
            data = qjr.data();
            if (initial && data["backtests"].length === 0) {
              _this.$modal.find(".select-backtest .dropdown-toggle").addClass("disabled");
              _this.$modal.find(".select-backtest .dropdown-toggle .dropdown-label").html("No backtests for this algorithm.");
            } else {
              _this.$modal.find(".select-backtest").removeClass("disabled");
            }
            ref = data["backtests"];
            for (i = 0, len = ref.length; i < len; i++) {
              backtest = ref[i];
              _this.$backtest_select.append("<option data-backtest-id='" + backtest.id + "'>" + (_.escape(backtest.name)) + "</option>");
            }
            if (data["is_more"]) {
              _this.$backtest_select.append("<option class='load-more'>+ Load More Backtests</option");
            }
            return _this.$backtest_select.val("Select a backtest").selectpicker("refresh");
          } else {
            return _this.loading_backtests_lock = false;
          }
        };
      })(this)).error((function(_this) {
        return function(response) {
          return _this.loading_backtests_lock = false;
        };
      })(this));
    };

    AttachBacktestModalManager.prototype.handle_algo_clicked = function(e) {
      var $click_target, algo_id, algo_title;
      $click_target = $(quanto.get_src_element(e)).find('option:selected');
      if ($click_target.hasClass("load-more")) {
        if (this.loading_algorithms_lock) {
          return;
        }
        this.algo_page += 1;
        this.load_algorithms(false);
        return;
      }
      algo_id = $click_target.data("algo-id");
      if ((this.selected_algorithm != null) && this.selected_algorithm["id"] === algo_id) {
        return;
      }
      algo_title = $click_target.html();
      this.selected_algorithm = {
        id: algo_id,
        title: algo_title
      };
      this.$backtest_select.html("");
      this.toggle_attach_enabled(false);
      this.backtest_page = 0;
      return this.load_backtests(algo_id, true);
    };

    AttachBacktestModalManager.prototype.toggle_attach_enabled = function(enabled) {
      if (enabled) {
        return this.$attach_backtest_button.removeClass("disabled");
      } else {
        return this.$attach_backtest_button.addClass("disabled");
      }
    };

    AttachBacktestModalManager.prototype.handle_backtest_clicked = function(e) {
      var $click_target, backtest_id, backtest_title;
      $click_target = $(quanto.get_src_element(e)).find('option:selected');
      if ($click_target.hasClass("load-more")) {
        if (this.loading_backtests_lock) {
          return;
        }
        this.backtest_page += 1;
        this.load_backtests(this.selected_algorithm["id"], false);
        return;
      }
      backtest_id = $click_target.data("backtest-id");
      backtest_title = $click_target.html();
      this.selected_backtest = {
        id: backtest_id,
        title: backtest_title
      };
      return this.toggle_attach_enabled(true);
    };

    return AttachBacktestModalManager;

  })();

}).call(this);
(function() {
  var AttachNotebookModalManager,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

  quanto.AttachNotebookModalManager = AttachNotebookModalManager = (function() {
    function AttachNotebookModalManager() {
      this.handle_row_double_clicked = bind(this.handle_row_double_clicked, this);
      this.handle_selection_changed = bind(this.handle_selection_changed, this);
      this.show_select_cell_step = bind(this.show_select_cell_step, this);
      this.open_folder = bind(this.open_folder, this);
      this.handle_attach_notebook_clicked = bind(this.handle_attach_notebook_clicked, this);
      this.reset_attach_button = bind(this.reset_attach_button, this);
      this.show_modal = bind(this.show_modal, this);
      this.get_bounce_back_data = bind(this.get_bounce_back_data, this);
      this.$modal = $("#attach-notebook-modal");
      this.$attach_notebook_btn = $("#attach-notebook-button");
      this.$notebook_name = this.$modal.find('.nb-name');
      this.notebook_chooser = new quanto.NotebookChooser(this.$modal, false);
      $(this.notebook_chooser).on('selection_changed', this.handle_selection_changed);
      $(this.notebook_chooser).on('row_dbl_clicked', this.handle_row_double_clicked);
      this.$attach_notebook_btn.on("click", this.handle_attach_notebook_clicked);
      if ($('#show-attach-nb').length > 0) {
        this.$modal.removeClass('fade');
        this.show_modal();
        this.$modal.addClass('fade');
      }
    }

    AttachNotebookModalManager.prototype.get_bounce_back_data = function() {
      var $titlebox, data;
      data = {
        post_body: _.str.trim($("#wmd-input").val())
      };
      $titlebox = $("#titlebox");
      if ($titlebox.length > 0) {
        data.post_title = _.str.trim($titlebox.val());
      }
      return data;
    };

    AttachNotebookModalManager.prototype.show_modal = function() {
      var data;
      this.reset_attach_button();
      data = this.get_bounce_back_data();
      data.show_modal = 'attach_notebook';
      this.notebook_chooser.show_chooser(data);
      return this.$modal.modal("show");
    };

    AttachNotebookModalManager.prototype.reset_attach_button = function() {
      this.$attach_notebook_btn.text("Next");
      return this.$attach_notebook_btn.addClass("disabled");
    };

    AttachNotebookModalManager.prototype.handle_attach_notebook_clicked = function(event) {
      var attach_btn_text;
      attach_btn_text = this.$attach_notebook_btn.text();
      switch (attach_btn_text) {
        case "Open":
          return this.open_folder(this.selected_row.url);
        case "Next":
          return this.show_select_cell_step(this.selected_row.url);
        case "Attach":
          $(document).trigger("attach_notebook", {
            research_host_url: this.notebook_chooser.research_host_url,
            notebook: this.selected_row
          });
          return this.$modal.modal("hide");
      }
    };

    AttachNotebookModalManager.prototype.open_folder = function(url) {
      this.$attach_notebook_btn.text('Opening...');
      this.$attach_notebook_btn.addClass('disabled');
      return this.notebook_chooser.open_folder(url, (function(_this) {
        return function() {
          return _this.$attach_notebook_btn.text("Next");
        };
      })(this));
    };

    AttachNotebookModalManager.prototype.show_select_cell_step = function(url) {
      this.$attach_notebook_btn.addClass('disabled');
      return this.notebook_chooser.show_select_cell_step(url, (function(_this) {
        return function() {
          _this.$attach_notebook_btn.text("Attach");
          return _this.$attach_notebook_btn.removeClass('disabled');
        };
      })(this));
    };

    AttachNotebookModalManager.prototype.handle_selection_changed = function(e, selected_row) {
      this.selected_row = selected_row;
      if (this.selected_row.type === "notebook") {
        this.$notebook_name.text(this.selected_row.name);
        this.$attach_notebook_btn.text("Next");
        return this.$attach_notebook_btn.removeClass("disabled");
      } else if (this.selected_row.type === "directory") {
        this.$attach_notebook_btn.text("Open");
        return this.$attach_notebook_btn.removeClass("disabled");
      } else {
        return this.reset_attach_button();
      }
    };

    AttachNotebookModalManager.prototype.handle_row_double_clicked = function(e, clicked_row) {
      switch (clicked_row.type) {
        case "notebook":
          return this.show_select_cell_step(clicked_row.url);
        case "directory":
          return this.open_folder(clicked_row.url);
      }
    };

    return AttachNotebookModalManager;

  })();

}).call(this);
(function() {
  var BacktestSummaryManager,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

  quanto.BacktestSummaryManager = BacktestSummaryManager = (function() {
    function BacktestSummaryManager($container, backtest_id, q2_backtest_id) {
      var $cached_data, cached_data_url, capital_base, capital_base_string, end_date, end_date_string, fallback, start_date, start_date_string;
      if (q2_backtest_id == null) {
        q2_backtest_id = null;
      }
      this.initialize_chart = bind(this.initialize_chart, this);
      this.add_custom_data_to_charts = bind(this.add_custom_data_to_charts, this);
      this.add_data_to_charts = bind(this.add_data_to_charts, this);
      this.resize_chart = bind(this.resize_chart, this);
      this.populate_summary = bind(this.populate_summary, this);
      this.populate_metrics = bind(this.populate_metrics, this);
      this.populate_error_data = bind(this.populate_error_data, this);
      this.consume = bind(this.consume, this);
      this.dispose = bind(this.dispose, this);
      this.bind_websocket = bind(this.bind_websocket, this);
      this.initialize_codemirror = bind(this.initialize_codemirror, this);
      this.handle_failure = bind(this.handle_failure, this);
      this.handle_url = bind(this.handle_url, this);
      this.find_series_by_name = bind(this.find_series_by_name, this);
      this.get_handlebars_template = bind(this.get_handlebars_template, this);
      this.$container = $container;
      this.backtest_id = backtest_id;
      this.q2_backtest_id = q2_backtest_id;
      this.percentage_fields = {
        "total_returns": "tr",
        "benchmark_returns": "br",
        "max_drawdown": "md"
      };
      this.cumulative_fields = {
        "alpha": "al",
        "volatility": "vo",
        "beta": "be",
        "benchmark_volatility": "bv",
        "sharpe": "sh",
        "sortino": "so",
        "benchmark_returns": "br",
        "total_returns": "tr",
        "max_drawdown": "md"
      };
      this.handlebar_templates = {
        "row_template": "<tr><td class='date'>{{date}}</td><td class='text-right'>{{{one_month}}}</td><td class='text-right'>{{{three_month}}}</td><td class='text-right'>{{{six_month}}}</td><td class='text-right'>{{{twelve_month}}}</td></tr>",
        "custom_series_template": "<div class='payload legend-item' custom-chart-label legend-item inline-block payload' data-key='{{key}}'><span class='square' style='background-color: {{color}}'></span><span style='color: {{color}}'>{{key}}</span><span class='chart-value' style='color: {{color}}' data-key='{{key}}'></span></div>"
      };
      this.$code_container = this.$container.find(".code-container");
      this.$container.find(".codelink").on("shown.bs.tab", (function(_this) {
        return function() {
          return setTimeout((function() {
            var ref;
            _this.initialize_codemirror(_this.$container.find(".code-snapshot-textbox"), _this.backtest_id);
            if ((ref = quanto.editor_snapshot) != null) {
              ref.refresh();
            }
            return $(".code-sidebar-filler").width($(".CodeMirror-gutter-wrapper").width());
          }), 10);
        };
      })(this));
      this.$container.find(".migrated-codelink").on("shown.bs.tab", (function(_this) {
        return function() {
          return setTimeout((function() {
            var ref;
            _this.initialize_codemirror(_this.$container.find(".migrated-code-snapshot-textbox"), _this.q2_backtest_id);
            return (ref = quanto.editor_snapshot) != null ? ref.refresh() : void 0;
          }), 10);
        };
      })(this));
      start_date = new Date(parseInt(this.$container.find(".data_backtest_start_date_ms").val()));
      start_date = quanto.date.adjust_date_for_UTC(start_date);
      start_date_string = quanto.date.format_date("%Y-%m-%d", start_date);
      end_date = new Date(parseInt(this.$container.find(".data_backtest_end_date_ms").val()));
      end_date = quanto.date.adjust_date_for_UTC(end_date);
      end_date_string = quanto.date.format_date("%Y-%m-%d", end_date);
      this.$container.find(".backtest_start_date_display").html(start_date_string);
      this.$container.find(".backtest_end_date_display").html(end_date_string);
      capital_base = parseInt(this.$container.find(".data_backtest_capital_base").val());
      capital_base_string = new Number(capital_base).toMoney(0);
      this.$container.find(".backtest_capitalbase_display").html("" + capital_base_string);
      if (quanto.get_query_variable("c") === "1") {
        this.$container.find(".clone-backtest-button").tooltip('show');
        $(".tooltip-inner").on("mouseover", (function(_this) {
          return function(e) {
            return _this.$container.find(".clone-backtest-button").tooltip('hide');
          };
        })(this));
      }
      this.$container.addClass("backtest-loaded");
      $cached_data = this.$container.find(".backtest-cached-data-url");
      fallback = false;
      if ($cached_data.length > 0 && quanto.get_query_variable("w") !== "1") {
        cached_data_url = $cached_data.val();
        $.get(cached_data_url, (function(_this) {
          return function(data) {
            var error;
            if (data != null) {
              try {
                _this.data_buffer = JSON.parse(data);
                _this.received_perf_data = [];
                _this.consume();
              } catch (error1) {
                error = error1;
                console.log(error);
                return fallback = true;
              }
            }
          };
        })(this));
      } else {
        fallback = true;
      }
      if (fallback) {
        quanto.get_server({
          success_callback: this.handle_url,
          failure_callback: this.handle_failure,
          task_id: this.backtest_id
        });
      }
    }

    BacktestSummaryManager.prototype.get_handlebars_template = function(name) {
      quanto.compiled_handlebar_templates || (quanto.compiled_handlebar_templates = {});
      if (quanto.compiled_handlebar_templates[name] == null) {
        quanto.compiled_handlebar_templates[name] = Handlebars.compile(this.handlebar_templates[name]);
      }
      return quanto.compiled_handlebar_templates[name];
    };

    BacktestSummaryManager.prototype.find_series_by_name = function(name) {
      if ((this.chart == null) || (this.chart.series == null)) {
        return null;
      }
      return _.find(this.chart.series, ((function(_this) {
        return function(series) {
          return series.name === name;
        };
      })(this)));
    };

    BacktestSummaryManager.prototype.handle_url = function(server_ip, server_port, ws_open_msg) {
      this.server_ip = server_ip;
      this.server_port = server_port;
      this.ws_url = "wss://" + this.server_ip + ":" + this.server_port + "/backtests/" + this.backtest_id;
      return this.bind_websocket(this.ws_url, ws_open_msg);
    };

    BacktestSummaryManager.prototype.handle_failure = function() {
      $(".backtest-loading").hide();
      return $(".backtest-loading-error").show();
    };

    BacktestSummaryManager.prototype.initialize_codemirror = function(code_textbox, backtest_id) {
      var $elem, new_editor;
      $elem = code_textbox;
      if ($elem.length > 0 && !$elem.hasClass("codemirror-done")) {
        quanto.widget_editors || (quanto.widget_editors = {});
        new_editor = CodeMirror.fromTextArea($elem[0], {
          lineNumbers: true,
          mode: "python",
          indentUnit: 4,
          readOnly: true
        });
        quanto.widget_editors[backtest_id] = new_editor;
        return $elem.addClass("codemirror-done");
      }
    };

    BacktestSummaryManager.prototype.bind_websocket = function(url, ws_open_msg) {
      this.ws = new WebSocket(url);
      this.received_perf_data = [];
      this.data_buffer = [];
      this.consume();
      this.ws.onopen = (function(_this) {
        return function(evt) {
          console.log("summary ws open");
          return _this.ws.send(JSON.stringify({
            'e': 'open',
            'p': {
              'cursor': 0,
              'include_txn': false,
              'a': ws_open_msg
            }
          }));
        };
      })(this);
      this.ws.onerror = (function(_this) {
        return function(evt) {};
      })(this);
      this.ws.onmessage = (function(_this) {
        return function(evt) {
          return _this.data_buffer.push(JSON.parse(evt.data));
        };
      })(this);
      return this.ws.onclose = (function(_this) {
        return function(evt) {
          return console.log("summary ws closed");
        };
      })(this);
    };

    BacktestSummaryManager.prototype.dispose = function() {
      if (this.ws != null) {
        this.ws.send("ACK");
        this.ws.onmessage = function() {};
        this.ws.onclose = function() {};
        this.ws.close();
        this.ws = null;
      }
      return this.force_end = true;
    };

    BacktestSummaryManager.prototype.consume = function() {
      var benchmark, buckets, buffer_copy, data_packets, done, done_packets, error_packets, final_payload, first_perf_packet, last_perf_packet, percent_complete, risk_metric_packets;
      buffer_copy = this.data_buffer;
      this.data_buffer = [];
      done = false;
      if ((this.force_end != null) && this.force_end) {
        return;
      }
      if (buffer_copy.length > 0) {
        buckets = _.groupBy(buffer_copy, (function(data) {
          return data.e;
        }));
        data_packets = buckets["performance"];
        if ((data_packets != null) && data_packets.length > 0) {
          this.received_perf_data = this.received_perf_data.concat(data_packets);
          first_perf_packet = _.first(data_packets).p;
          benchmark = first_perf_packet.daily[0].bm;
          if ((benchmark != null) && benchmark !== -1) {
            quanto.set_benchmark(benchmark, ".red." + this.backtest_id);
          }
          last_perf_packet = _.last(data_packets).p;
          if (last_perf_packet != null) {
            percent_complete = quanto.pick_property(last_perf_packet, "percent_complete", "pc");
            if ((percent_complete != null) && !isNaN(percent_complete)) {
              this.progress = Math.floor(percent_complete * 1000) / 10;
              if ((this.progress != null) && !isNaN(this.progress) && this.progress >= 0 && this.progress <= 100) {
                this.$container.find(".backtest-progress-bar").css("width", this.progress + "%");
              }
            }
          }
        }
        done = false;
        final_payload = false;
        risk_metric_packets = buckets["risk_report"] || [];
        if (risk_metric_packets.length > 0) {
          this.received_risk_data = risk_metric_packets[0];
        }
        done_packets = buckets["done"];
        if ((done_packets != null) && done_packets.length > 0) {
          this.received_done_data = done_packets[0].p;
          done = true;
        }
        error_packets = buckets["exception"];
        if ((error_packets != null) && error_packets.length > 0) {
          this.received_error_data = error_packets[0].p;
          this.populate_error_data();
          done = true;
        }
      }
      if (!done) {
        return setTimeout(((function(_this) {
          return function() {
            return _this.consume();
          };
        })(this)), 1000);
      } else {
        this.$container.find(".loading-overlay").addClass("hidden");
        this.$container.find(".perf-chart-container").removeClass("hidden");
        this.populate_summary();
        this.populate_metrics();
        if (this.ws != null) {
          return this.ws.send("ACK");
        }
      }
    };

    BacktestSummaryManager.prototype.populate_error_data = function() {
      this.$container.find(".error-tab-header").show();
      this.$container.find(".error-tab-header a").trigger("click");
      this.error = true;
      return quanto.instances.error_renderer = new quanto.ErrorRenderer(this.$container.find(".backtest-widget-errors"), this.received_error_data, false, null, this.backtest_id);
    };

    BacktestSummaryManager.prototype.populate_metrics = function() {
      var $table, abbr, data, date_string, display, field, field_abbr, j, k, last_day, last_perf_frame, len, len1, metric, optional_metric, overall_metrics, ref, ref1, ref2, ref3, ref4, ref5, row_html, row_template, sorted_dates, val, values;
      last_perf_frame = _.last(this.received_perf_data);
      if (last_perf_frame == null) {
        return;
      }
      last_day = _.last(last_perf_frame.p.daily);
      overall_metrics = quanto.pick_property(last_day, "cumulative", "c");
      ref = this.cumulative_fields;
      for (metric in ref) {
        abbr = ref[metric];
        val = quanto.pick_property(overall_metrics, metric, abbr);
        if ((val != null) && !isNaN(val)) {
          if (_.indexOf(this.percentage_fields, metric) >= 0) {
            display = Math.floor(val * 10000) / 100;
            this.$container.find(".stat-value[datafield='" + metric + "']").html(display + "%");
          } else {
            display = val.toFixed(2);
            this.$container.find(".stat-value[datafield='" + metric + "']").html("" + display);
          }
        }
      }
      row_template = this.get_handlebars_template("row_template");
      if (this.received_risk_data != null) {
        ref1 = this.received_risk_data.p.metrics;
        for (metric in ref1) {
          values = ref1[metric];
          $table = this.$container.find("table[data-riskmetric='" + metric + "']");
          if ($table.length > 0) {
            sorted_dates = _.keys(values).sort();
            row_html = "";
            for (j = 0, len = sorted_dates.length; j < len; j++) {
              date_string = sorted_dates[j];
              data = values[date_string];
              if (_.indexOf(this.percentage_fields, metric) >= 0) {
                ref2 = quanto.risk_window_sizes;
                for (field_abbr in ref2) {
                  field = ref2[field_abbr];
                  val = quanto.pick_property(data, field_abbr, field);
                  if (val != null) {
                    data[field] = (Math.floor(val * 10000) / 100) + "%";
                  }
                }
              } else {
                ref3 = quanto.risk_window_sizes;
                for (field_abbr in ref3) {
                  field = ref3[field_abbr];
                  val = quanto.pick_property(data, field_abbr, field);
                  if (val != null) {
                    data[field] = Math.floor(val * 10000) / 10000;
                  }
                }
              }
              ref4 = quanto.risk_window_sizes;
              for (field_abbr in ref4) {
                field = ref4[field_abbr];
                val = quanto.pick_property(data, field_abbr, field);
                if (val == null) {
                  data[field] = "<span class='gray small'>N/A</span>";
                }
              }
              data["date"] = this.translate_date_string(date_string);
              row_html += row_template(data);
            }
            $table.find("tbody").append(row_html);
          }
        }
      }
      ref5 = ["sortino"];
      for (k = 0, len1 = ref5.length; k < len1; k++) {
        optional_metric = ref5[k];
        if (overall_metrics[optional_metric] == null) {
          this.$container.find("li[data-metric=" + optional_metric + "]").addClass("hidden");
        }
      }
      return $(".optional-metric-field").tooltip();
    };

    BacktestSummaryManager.prototype.translate_date_string = function(date_str) {
      var month, split_data, year;
      split_data = date_str.split("-");
      year = parseInt(split_data[0], 10);
      month = parseInt(split_data[1], 10);
      return quanto.date.months_list[month - 1] + " " + split_data[0];
    };

    BacktestSummaryManager.prototype.populate_summary = function() {
      var adjusted_timestamp, benchmark_perf, cumulative, daily_data, daily_data_buffer, given_date, j, k, key, l, last_perf_data, len, len1, len2, len3, m, new_date, payload, perf_frame, portfolio_perf, recorded_vars, ref, ref1, timestamp, value;
      daily_data_buffer = [];
      ref = this.received_perf_data;
      for (j = 0, len = ref.length; j < len; j++) {
        perf_frame = ref[j];
        payload = perf_frame.p;
        if (payload != null) {
          ref1 = payload.daily;
          for (k = 0, len1 = ref1.length; k < len1; k++) {
            daily_data = ref1[k];
            daily_data_buffer.push(daily_data);
          }
        }
      }
      last_perf_data = _.last(daily_data_buffer);
      given_date = new Date(quanto.pick_property(last_perf_data, "date", "d"));
      new_date = new Date(given_date.getFullYear(), given_date.getMonth(), given_date.getDate());
      this.backtest_end_date = quanto.date.adjust_date_for_UTC_reverse(new_date);
      this.received_custom_series = {};
      for (l = 0, len2 = daily_data_buffer.length; l < len2; l++) {
        daily_data = daily_data_buffer[l];
        recorded_vars = quanto.pick_property(daily_data, "recorded_vars", "rv");
        if (recorded_vars != null) {
          for (key in recorded_vars) {
            value = recorded_vars[key];
            this.received_custom_series[key] = true;
          }
        }
      }
      this.initialize_chart(this.received_custom_series);
      for (m = 0, len3 = daily_data_buffer.length; m < len3; m++) {
        daily_data = daily_data_buffer[m];
        timestamp = quanto.pick_property(daily_data, "date", "d");
        given_date = new Date(timestamp);
        new_date = new Date(given_date.getFullYear(), given_date.getMonth(), given_date.getDate());
        adjusted_timestamp = quanto.date.adjust_date_for_UTC_reverse(new_date).getTime();
        cumulative = quanto.pick_property(daily_data, "cumulative", "c");
        portfolio_perf = quanto.pick_property(cumulative, "total_returns", "tr");
        benchmark_perf = quanto.pick_property(cumulative, "benchmark_returns", "br");
        this.add_data_to_charts(adjusted_timestamp, portfolio_perf, benchmark_perf);
        recorded_vars = quanto.pick_property(daily_data, "recorded_vars", "rv");
        if (recorded_vars != null) {
          this.add_custom_data_to_charts(adjusted_timestamp, recorded_vars);
        }
      }
      this.$container.find(".nav-tabs a.disabled").removeClass("disabled");
      this.$container.find(".loading-tab").remove();
      if ((this.error == null) || !this.error) {
        this.$container.find(".tab-pane.perf").addClass("active");
      }
      $(window).on("resize", (function(_this) {
        return function(e) {
          if (_this.resizeTimer != null) {
            clearTimeout(_this.resizeTimer);
          }
          return _this.resizeTimer = setTimeout(_this.resize_chart, 100);
        };
      })(this));
      this.resize_chart();
      return this.$container.find(".legend-item").bind("click", (function(_this) {
        return function(e) {
          var $clicked, series, series_name;
          $clicked = $(quanto.get_src_element(e)).closest(".legend-item");
          series_name = $clicked.data("key");
          if (series_name == null) {
            return;
          }
          series = _this.find_series_by_name(series_name);
          if (series == null) {
            return;
          }
          if ($clicked.hasClass("unselected")) {
            $clicked.removeClass("unselected");
            return series.show();
          } else {
            $clicked.addClass("unselected");
            return series.hide();
          }
        };
      })(this));
    };

    BacktestSummaryManager.prototype.resize_chart = function() {
      var offset;
      offset = 20;
      if (_.keys(this.received_custom_series).length > 0) {
        return this.chart.setSize(this.$container.width() - offset, 433);
      } else {
        return this.chart.setSize(this.$container.width() - offset, 300);
      }
    };

    BacktestSummaryManager.prototype.add_data_to_charts = function(timestamp, portfolio_perf, benchmark_perf) {
      this.chart.series[0].addPoint([timestamp, portfolio_perf], false);
      return this.chart.series[1].addPoint([timestamp, benchmark_perf], false);
    };

    BacktestSummaryManager.prototype.add_custom_data_to_charts = function(timestamp, custom_vars) {
      var key, results, series, value;
      results = [];
      for (key in custom_vars) {
        value = custom_vars[key];
        series = _.find(this.chart.series, (function(_this) {
          return function(series) {
            return series.name === key;
          };
        })(this));
        results.push(series.addPoint([timestamp, value], false));
      }
      return results;
    };

    BacktestSummaryManager.prototype.initialize_chart = function(custom_series_data) {
      var colorToUse, custom_series_template, key, legend_html, new_axis, options, series, value;
      if (custom_series_data == null) {
        custom_series_data = {};
      }
      options = {
        global: {
          useUTC: true
        },
        chart: {
          renderTo: "perf-summary-chart-" + this.backtest_id,
          alignTicks: true
        },
        credits: {
          enabled: false
        },
        navigator: {
          series: {
            color: 'transparent',
            lineWidth: 0
          },
          height: 20,
          maskFill: 'rgba(180, 198, 220, 0.75)',
          xAxis: {
            type: 'datetime',
            dateTimeLabelFormats: {
              day: '%b %e',
              week: '%b %e',
              month: '%b %Y'
            }
          }
        },
        rangeSelector: {
          enabled: false
        },
        title: {
          text: null
        },
        series: [
          {
            type: 'area',
            name: 'Returns',
            data: [],
            dataGrouping: quanto.global_grouping_options,
            yAxis: 0,
            color: '#4572A7',
            fillOpacity: .2
          }, {
            type: 'line',
            name: 'Benchmark',
            data: [],
            dataGrouping: quanto.global_grouping_options,
            yAxis: 0,
            lineWidth: 1,
            color: '#aa4643'
          }
        ],
        yAxis: [
          {
            title: {
              text: null
            },
            height: 192,
            offset: 0,
            labels: {
              formatter: function() {
                return this.value * 100 + "%";
              }
            },
            minorGridLineWidth: 1,
            minorTickInterval: 'auto',
            minorTickWidth: 0,
            opposite: true,
            lineWidth: 1,
            plotLines: [
              {
                value: 0,
                color: 'black',
                width: 2
              }
            ]
          }
        ],
        xAxis: {
          ordinal: false,
          dateTimeLabelFormats: {
            day: '%b %e',
            week: '%b %e',
            month: '%b %Y'
          },
          gridLineWidth: 1,
          gridLineColor: 'lightgray'
        },
        plotOptions: quanto.global_plotOptions,
        tooltip: {
          hideCallback: function(chart) {
            var $container, benchmark_change, benchmark_end, benchmark_series_points, benchmark_start, points, returns_change, returns_end, returns_start;
            $container = $(chart.container).closest(".backtest-widget");
            $(".date-chart-label").html("").hide();
            if (chart.hoverPoints != null) {
              $.each(chart.hoverPoints, function(i, point) {
                return point.setState("");
              });
            }
            if ((chart.series != null) && chart.series.length > 2) {
              points = chart.series[0].points;
              if ((points == null) || points.length <= 2 || (points[0] == null)) {
                return;
              }
              returns_start = points[0].y;
              returns_end = _.last(points).y;
              returns_change = returns_end - returns_start;
              benchmark_series_points = chart.series[1].points;
              benchmark_change = null;
              if ((benchmark_series_points != null) && benchmark_series_points.length >= 2) {
                benchmark_start = benchmark_series_points[0].y;
                benchmark_end = _.last(benchmark_series_points).y;
                benchmark_change = benchmark_end - benchmark_start;
              }
              quanto.BacktestSummaryManager.display_perf_chart_values($container, returns_change, benchmark_change);
            }
            return $container.find(".custom-variable-legend .payload .chart-value").html("");
          },
          formatter: function() {
            var $container, benchmark, custom_points, datestring, grouping, j, len, perf, point, ref, series_name;
            if ((this.points == null) || this.points.length === 0) {
              return false;
            }
            grouping = this.points[0].series.currentDataGrouping;
            if ((grouping != null) && (grouping != null ? grouping.unitName : void 0) === "week") {
              datestring = "Week of " + (Highcharts.dateFormat('%b %e, %Y', this.x, false));
            } else {
              datestring = Highcharts.dateFormat('%b %e, %Y', this.x, false);
            }
            $container = $(this.points[0].series.chart.container).closest(".backtest-widget");
            $container.find(".date-chart-label").html(datestring).show();
            perf = null;
            benchmark = null;
            custom_points = [];
            ref = this.points;
            for (j = 0, len = ref.length; j < len; j++) {
              point = ref[j];
              series_name = point.series.name;
              if (series_name === "End") {
                continue;
              }
              if (series_name === "Returns") {
                perf = point.y;
              } else if (series_name === "Benchmark") {
                benchmark = point.y;
              } else {
                custom_points.push(point);
              }
            }
            quanto.BacktestSummaryManager.display_perf_chart_values($container, perf, benchmark);
            if (custom_points.length > 0) {
              quanto.BacktestSummaryManager.display_custom_var_values($container, custom_points);
            }
            return false;
          }
        }
      };
      if ((custom_series_data != null) && _.keys(custom_series_data).length > 0) {
        this.$container.find(".tab-pane.perf").addClass("showing-custom");
        new_axis = {
          title: {
            text: null
          },
          height: 100,
          top: 260,
          opposite: true,
          lineWidth: 1,
          startOnTick: true,
          endOnTick: true,
          minPadding: 0.05,
          maxPadding: 0.05,
          forceTickRecalculate: true,
          plotLines: [
            {
              value: 0,
              color: 'black',
              width: 2
            }
          ]
        };
        options.yAxis.push(new_axis);
        custom_series_template = this.get_handlebars_template("custom_series_template");
        for (key in custom_series_data) {
          value = custom_series_data[key];
          colorToUse = quanto.custom_chart_colors[(options.series.length - 2) % quanto.custom_chart_colors.length];
          series = {
            type: 'line',
            name: key,
            data: [],
            dataGrouping: quanto.global_grouping_options,
            yAxis: 1,
            lineWidth: 1,
            color: colorToUse
          };
          options.series.push(series);
          legend_html = custom_series_template({
            key: key,
            color: colorToUse
          });
          this.$container.find(".custom-vars-legend-container").append(legend_html);
          this.$container.find(".custom-variable-legend").show();
        }
      }
      this.chart = new Highcharts.StockChart(options);
      if ((this.backtest_end_date != null) && !isNaN(this.backtest_end_date.getTime())) {
        return this.chart.addSeries({
          name: 'End',
          data: [[this.backtest_end_date.getTime(), 0]]
        });
      }
    };

    BacktestSummaryManager.display_custom_var_values = function($container, custom_points, chart) {
      var j, len, point, results;
      results = [];
      for (j = 0, len = custom_points.length; j < len; j++) {
        point = custom_points[j];
        results.push($container.find(".custom-variable-legend .payload[data-key=" + point.series.name + "] .chart-value").html(Math.round(point.y * 100) / 100));
      }
      return results;
    };

    BacktestSummaryManager.display_perf_chart_values = function($container, performance_fraction, benchmark_fraction) {
      var $benchmark_label, $perf_label, benchmark_pct, perf_pct;
      if (benchmark_fraction == null) {
        benchmark_fraction = 0;
      }
      perf_pct = Math.floor(performance_fraction * 10000) / 100;
      benchmark_pct = Math.floor(benchmark_fraction * 10000) / 100;
      $perf_label = $container.find(".performance-value");
      $benchmark_label = $container.find(".benchmark-value");
      $perf_label.html(perf_pct + "%");
      $benchmark_label.html(benchmark_pct + "%");
      if (perf_pct < 0) {
        $perf_label.addClass("negative");
      } else {
        $perf_label.removeClass("negative");
      }
      if (benchmark_pct < 0) {
        return $benchmark_label.addClass("negative");
      } else {
        return $benchmark_label.removeClass("negative");
      }
    };

    return BacktestSummaryManager;

  })();

}).call(this);
(function() {
  var EventManager,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

  quanto.EventManager = EventManager = (function() {
    function EventManager() {
      this.initialize_mobile_scroller = bind(this.initialize_mobile_scroller, this);
      this.build_url_with_params = bind(this.build_url_with_params, this);
      this.$event_select = $('#event-type-select');
      this.$location_select = $('#event-location-select');
      this.$event_select.selectpicker();
      this.$event_select.on('loaded.bs.select', (function(_this) {
        return function(e) {
          return $('.select-type').removeClass('invisible');
        };
      })(this));
      this.$location_select.selectpicker();
      this.$location_select.on('loaded.bs.select', (function(_this) {
        return function(e) {
          return $('.select-location').removeClass('invisible');
        };
      })(this));
      $(document).pjax('[data-pjax] a, a[data-pjax]', '.pjax-container');
      $(document).on('pjax:success', (function(_this) {
        return function() {
          var history, page_title;
          _this.initialize_mobile_scroller();
          history = quanto.get_url_parameter_by_name('history');
          if (history === 'true') {
            page_title = 'Past events at Quantopian';
          } else {
            page_title = 'Upcoming events at Quantopian';
          }
          return $('.header-row').find('.title').text(page_title);
        };
      })(this));
      this.$event_select.on('changed.bs.select', (function(_this) {
        return function(e) {
          var url;
          url = _this.build_url_with_params();
          return $.pjax({
            url: url,
            container: '.pjax-container'
          });
        };
      })(this));
      this.$location_select.on('changed.bs.select', (function(_this) {
        return function(e) {
          var url;
          url = _this.build_url_with_params();
          return $.pjax({
            url: url,
            container: '.pjax-container'
          });
        };
      })(this));
      this.initialize_mobile_scroller();
      $(window).resize((function(_this) {
        return function() {
          return _this.initialize_mobile_scroller();
        };
      })(this));
    }

    EventManager.prototype.build_url_with_params = function() {
      var history, location, type, url_str;
      history = quanto.get_url_parameter_by_name('history');
      type = this.$event_select.find('option:selected').data('title');
      location = this.$location_select.find('option:selected').data('title');
      url_str = "?";
      if (type && type !== 'all') {
        url_str += "type=" + type;
      }
      if (location && location !== 'all') {
        if (url_str !== "?") {
          url_str += "&";
        }
        url_str += "location=" + location;
      }
      if (history === 'true') {
        if (url_str !== "?") {
          url_str += "&";
        }
        url_str += "history=true";
      }
      return url_str;
    };

    EventManager.prototype.initialize_mobile_scroller = function() {
      var i, j, mobile_scroller, mobile_width, num_elements, ref, results;
      mobile_width = 767;
      if ($(window).width() < mobile_width) {
        num_elements = $('.mobile-scroller-wrapper').length;
        results = [];
        for (i = j = 0, ref = num_elements - 1; 0 <= ref ? j <= ref : j >= ref; i = 0 <= ref ? ++j : --j) {
          results.push(mobile_scroller = new IScroll('#wrapper' + i, {
            scrollX: true,
            scrollY: false,
            preventDefault: true,
            mouseWheel: false,
            click: true
          }));
        }
        return results;
      }
    };

    return EventManager;

  })();

}).call(this);
(function() {
  var ForumIndexManager,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

  quanto.ForumIndexManager = ForumIndexManager = (function() {
    function ForumIndexManager() {
      this.see_all_tags = bind(this.see_all_tags, this);
      this.track_search_on_mixpanel = bind(this.track_search_on_mixpanel, this);
      this.trigger_search = bind(this.trigger_search, this);
      this.set_search_state = bind(this.set_search_state, this);
      this.show_advanced_options = bind(this.show_advanced_options, this);
      this.initialize_search = bind(this.initialize_search, this);
      this.display_listen_ui_for_option = bind(this.display_listen_ui_for_option, this);
      this.send_listen_option = bind(this.send_listen_option, this);
      this.initialize_auto_listening = bind(this.initialize_auto_listening, this);
      this.sidebar_track_redirect_click = bind(this.sidebar_track_redirect_click, this);
      this.handle_paginate_link = bind(this.handle_paginate_link, this);
      this.initialize_paginate_links = bind(this.initialize_paginate_links, this);
      var path, tm;
      this.$content_area = $('.wrapper');
      this.$posts_area = this.$content_area.find('.posts-area');
      this.$loading_page_area = this.$content_area.find('.show-while-paging');
      this.$page_container = this.$content_area.find('.page-container');
      this.$main_row = this.$content_area.find('.main-row');
      this.$search_area = this.$content_area.find('.search-input-area');
      this.$advanced_search_options_area = this.$content_area.find('.advanced-search-options-row');
      this.$search_icon = this.$content_area.find('.search-icon-container');
      this.$search_box = this.$content_area.find('#search-box');
      this.$close_search_area = this.$content_area.find('.icon-close-wrapper');
      this.$announcements = this.$content_area.find('.announcement');
      this.$attachment_select = $('.attachment-select');
      this.$attachment_select.selectpicker();
      this.$attachment_select.change((function(_this) {
        return function(e) {
          var elem;
          elem = $(quanto.get_src_element(e));
          if (!$(elem).hasClass('mobile')) {
            return setTimeout((function() {
              return _this.trigger_search();
            }), 100);
          }
        };
      })(this));
      this.$time_frame_select = $('.time-frame-select');
      this.$time_frame_select.selectpicker();
      this.$time_frame_select.change((function(_this) {
        return function(e) {
          var elem;
          elem = $(quanto.get_src_element(e));
          if (!$(elem).hasClass('mobile')) {
            return setTimeout((function() {
              return _this.trigger_search();
            }), 100);
          }
        };
      })(this));
      tm = new quanto.TagManager();
      this.initialize_search();
      this.initialize_auto_listening();
      this.initialize_paginate_links();
      tm.initialize_add_tag_modal();
      quanto.on_click(".forum-sidebar-button", (function(_this) {
        return function(e) {
          return _this.sidebar_track_redirect_click(e);
        };
      })(this));
      quanto.on_click(".see-all-tags", (function(_this) {
        return function(e) {
          return _this.see_all_tags();
        };
      })(this));
      quanto.on_click(".back-to-community", (function(_this) {
        return function(e) {
          return quanto.go_to_community_home();
        };
      })(this));
      quanto.on_click(".select-tags", (function(_this) {
        return function(e) {
          return tm.add_tags(e);
        };
      })(this));
      quanto.on_click("#save-tags-button", (function(_this) {
        return function(e) {
          tm.select_tags_for_search("#add-tags-to-post-modal");
          return setTimeout((function() {
            return _this.trigger_search();
          }), 100);
        };
      })(this));
      quanto.on_click(".mobile-advanced-search-button", (function(_this) {
        return function(e) {
          $('.mobile-advanced-search-options').addClass('hidden');
          $('.hide-on-mobile-tag-tab').removeClass('hidden');
          tm.select_tags_for_search(".mobile-advanced-search-options");
          return setTimeout((function() {
            return _this.trigger_search();
          }), 100);
        };
      })(this));
      quanto.on_click(".advanced-options-mobile-link", (function(_this) {
        return function(e) {
          tm.update_add_tags_mobile();
          $('.mobile-advanced-search-options').removeClass('hidden');
          $('.hide-on-mobile-tag-tab').addClass('hidden');
          return $('.mobile-tab-row').addClass('hidden');
        };
      })(this));
      quanto.on_click(".close-advanced-search", (function(_this) {
        return function(e) {
          $('.mobile-advanced-search-options').addClass('hidden');
          $('.hide-on-mobile-tag-tab').removeClass('hidden');
          return $('.mobile-tab-row').removeClass('hidden');
        };
      })(this));
      quanto.on_click(".mobile-tab", (function(_this) {
        return function(e) {
          $('.mobile-advanced-search-options').addClass('hidden');
          $(".mobile-tab").toggleClass('active');
          if ($('.tags-tab').hasClass('active')) {
            $('.mobile-see-all-tags').removeClass('hidden');
            return $('.hide-on-mobile-tag-tab').addClass('hidden');
          } else {
            $('.mobile-see-all-tags').addClass('hidden');
            return $('.hide-on-mobile-tag-tab').removeClass('hidden');
          }
        };
      })(this));
      $(".backtest-icon").tooltip({
        title: "This post has an attached backtest.",
        container: '.posts-area'
      });
      $(".notebook-icon").tooltip({
        title: "This post has an attached research notebook.",
        container: '.posts-area'
      });
      $(".badge.medal").tooltip({
        title: "This user is a Quantopian challenge winner.",
        container: '.posts-area'
      });
      path = window.location.pathname;
      if (path === "/posts/newest") {
        quanto.set_community_home_page_cookie('newest');
      } else {
        quanto.set_community_home_page_cookie('interesting');
      }
    }

    ForumIndexManager.prototype.initialize_paginate_links = function() {
      this.$paginate_links = this.$page_container.find('.quanto-paginate a');
      return this.$paginate_links.click(this.handle_paginate_link);
    };

    ForumIndexManager.prototype.handle_paginate_link = function(e) {
      var $clicked_link, $placeholder, link_path, pagination_top_before;
      $clicked_link = $(e.target);
      link_path = $clicked_link.attr('href');
      this.$paginate_links.off('click');
      $placeholder = $('.paging-placeholder');
      $placeholder.html(this.$posts_area.html());
      pagination_top_before = $('.pagination').offset().top;
      this.$main_row.css('min-height', this.$posts_area.height());
      this.set_search_state('paging');
      $('body').animate({
        scrollTop: 0
      }, 10);
      window.location.href = link_path;
      return false;
    };

    ForumIndexManager.prototype.sidebar_track_redirect_click = function(e) {
      var $clicked_elem, sidebar_item, url, user_type;
      $clicked_elem = $(quanto.get_src_element(e));
      if (quanto.is_anonymous()) {
        user_type = "anonymous";
      } else {
        user_type = "registered";
      }
      sidebar_item = $clicked_elem.data("mixpanel") || $clicked_elem.html();
      mixpanel.track("forum sidebar click", {
        "link": sidebar_item,
        "user_type": user_type
      });
      url = $clicked_elem.data("url");
      if (!_.str.startsWith(url, 'http')) {
        url = 'http://' + url;
      }
      return window.open(url);
    };

    ForumIndexManager.prototype.initialize_auto_listening = function() {
      this.auto_listen = $("#autolisten-state").val() === "true";
      this.display_listen_ui_for_option(this.auto_listen);
      quanto.on_click(".listening-options a", (function(_this) {
        return function(e) {
          var $clicked, new_listen_option;
          $clicked = $(quanto.get_src_element(e)).closest("a");
          new_listen_option = $clicked.data("listen-option") === "on";
          if (_this.auto_listen === new_listen_option) {

          } else {
            return _this.send_listen_option(new_listen_option);
          }
        };
      })(this));
      return quanto.on_click("#listen-button", (function(_this) {
        return function(e) {
          return _this.send_listen_option(!_this.auto_listen);
        };
      })(this));
    };

    ForumIndexManager.prototype.send_listen_option = function(option) {
      var data;
      data = {
        id: $("#current_user_id").val(),
        listen_option: option
      };
      $(".listening-options button").addClass("disabled");
      return $.post("/users/toggle_autolisten", data, (function(_this) {
        return function(response) {
          var qjr;
          $(".listening-options button").removeClass("disabled");
          qjr = new quanto.JsonResponse(response);
          if (qjr.ok()) {
            _this.auto_listen = qjr.data()["new_value"];
            return _this.display_listen_ui_for_option(_this.auto_listen);
          }
        };
      })(this)).error((function(_this) {
        return function(response) {
          alert("There was a problem updating your preferences.");
          return $(".listening-options button").removeClass("disabled");
        };
      })(this));
    };

    ForumIndexManager.prototype.display_listen_ui_for_option = function(option) {
      if (option) {
        $("#listen-off-row").removeClass("selected");
        $("#listen-on-row").addClass("selected");
        return $("#listen-button").html("Stop Auto Listen");
      } else {
        $("#listen-off-row").addClass("selected");
        $("#listen-on-row").removeClass("selected");
        return $("#listen-button").html("Auto Listen");
      }
    };

    ForumIndexManager.prototype.initialize_search = function() {
      var query, tag, text;
      this.search_mode = false;
      this.$close_search_area.addClass('hidden');
      this.$search_icon.click((function(_this) {
        return function() {
          return _this.$search_box.focus();
        };
      })(this));
      this.$search_box.focus((function(_this) {
        return function() {
          _this.$search_area.addClass('active');
          _this.$page_container.addClass('search-active');
          _this.show_advanced_options(true);
          return _this.$search_icon.addClass("hidden");
        };
      })(this));
      $(".content-area").mouseup((function(_this) {
        return function(e) {
          if ($(e.target).closest('.search-input-area, #add-tags-to-post-modal').length === 0 && $('.attachment-option.selected').data('name') === 'all') {
            if (_this.$search_box.val() === "") {
              _this.$search_area.removeClass('active');
              _this.$page_container.removeClass('search-active');
              if (!_this.$advanced_search_options_area.hasClass('mobile')) {
                _this.$advanced_search_options_area.addClass('hidden');
              }
              _this.$close_search_area.addClass('hidden');
              return _this.$search_area.removeClass('has-value');
            }
          }
        };
      })(this));
      this.$close_search_area.click((function(_this) {
        return function() {
          _this.$search_box.val("");
          _this.$search_area.removeClass('has-value');
          _this.set_search_state("");
          _this.$advanced_search_options_area.addClass('hidden');
          window.location = '/posts';
          return _this.$search_icon.removeClass("hidden");
        };
      })(this));
      this.$search_box.keydown((function(_this) {
        return function(e) {
          if (_this.$search_box.val() !== "") {
            _this.$search_area.addClass('has-value');
            _this.$close_search_area.removeClass('hidden');
          } else {
            _this.$search_area.removeClass('has-value');
            _this.$close_search_area.addClass('hidden');
          }
          if (e.which === 13) {
            return _this.trigger_search();
          }
        };
      })(this));
      query = $('.page-title').data('query');
      tag = $('.page-title').data('tag');
      text = "";
      if (tag) {
        text = "[" + tag.replace(/,/g, '][') + "] ";
      }
      if (query) {
        text += query;
      }
      this.$search_box.val(text);
      if (this.$search_box.val() !== "" || $('#advanced-options-group .attachment-select option:selected').val() !== 'all' || $('.page-title').data('date-filter') !== "") {
        this.$search_area.addClass('active');
        this.$search_area.addClass("force-open");
        this.$page_container.addClass('search-active');
        this.show_advanced_options(true);
      }
      if (this.$search_box.val() !== "") {
        this.$close_search_area.css('display', 'block');
        return this.$close_search_area.removeClass('hidden');
      }
    };

    ForumIndexManager.prototype.show_advanced_options = function(force_open) {
      if (force_open) {
        this.$advanced_search_options_area.addClass('force-open');
      }
      return this.$advanced_search_options_area.removeClass('hidden');
    };

    ForumIndexManager.prototype.set_search_state = function(state) {
      this.$page_container.removeClass('searching search-complete paging');
      return this.$page_container.addClass(state);
    };

    ForumIndexManager.prototype.trigger_search = function() {
      var attachment, date_filter, filter_url, formatted_tag_array, i, j, len, len1, name, param_delimiter, params, path, query, query_without_tag, ref, regex, sort_by_newest, tag, tag_array, tag_string, url, value;
      this.$search_box.blur();
      query = this.$search_box.val();
      attachment = this.$attachment_select.find('option:selected').val();
      date_filter = this.$time_frame_select.find('option:selected').val();
      sort_by_newest = $('.active.sort-by').hasClass('sort-by-newest');
      if (sort_by_newest) {
        filter_url = "/newest";
      } else {
        filter_url = "";
      }
      if ($.trim(query).length < 1) {
        path = '/posts';
        if (attachment !== 'all') {
          path += '/' + attachment;
          this.track_search_on_mixpanel("", [attachment + "-only"], date_filter);
        } else if (date_filter !== 'all') {
          this.track_search_on_mixpanel("", [], date_filter);
        }
        path += filter_url;
        if (date_filter !== 'all') {
          path += '?date_filter=' + date_filter;
        }
        window.location.href = path;
        return;
      }
      this.set_search_state('searching');
      regex = /[^[\]]+(?=])/g;
      tag_array = query.match(regex);
      params = [];
      query_without_tag = query;
      formatted_tag_array = [];
      if (tag_array !== null) {
        tag_string = "";
        if (tag_array.length === 1) {
          tag = tag_array[0];
          formatted_tag_array.push(tag);
          query_without_tag = query_without_tag.replace('[' + tag + ']', '').trim();
          path = '/posts/tag/' + tag.split('/').join('_').split(' ').join('-');
        } else {
          for (i = 0, len = tag_array.length; i < len; i++) {
            tag = tag_array[i];
            query_without_tag = query_without_tag.replace('[' + tag + ']', '').trim();
            formatted_tag_array.push(tag.split(' ').join('-'));
          }
          if (query_without_tag === "") {
            path = '/posts/tag';
          } else {
            path = '/posts';
          }
          params.push(['tags', formatted_tag_array.join(",")]);
        }
      } else {
        path = '/posts';
      }
      if (query_without_tag === "") {
        path += filter_url;
      } else {
        path += '/search';
        params.push(['q', query_without_tag]);
      }
      if (attachment !== 'all') {
        params.push(['attachment', attachment]);
      }
      if (date_filter !== 'all') {
        params.push(['date_filter', date_filter]);
      }
      this.track_search_on_mixpanel(query_without_tag, formatted_tag_array, date_filter);
      url = path;
      param_delimiter = '?';
      for (j = 0, len1 = params.length; j < len1; j++) {
        ref = params[j], name = ref[0], value = ref[1];
        url += param_delimiter + name + '=' + value;
        param_delimiter = '&';
      }
      return window.location.href = url;
    };

    ForumIndexManager.prototype.track_search_on_mixpanel = function(query, tags, time_frame) {
      return mixpanel.track("forums search query", {
        "query": query,
        "tag": tags.join(","),
        "time frame": time_frame
      });
    };

    ForumIndexManager.prototype.see_all_tags = function() {
      return $('#see-all-tags-modal').modal("show");
    };

    return ForumIndexManager;

  })();

}).call(this);
(function() {
  var NewPostManager,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; },
    extend = function(child, parent) { for (var key in parent) { if (hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; },
    hasProp = {}.hasOwnProperty;

  quanto.NewPostManager = NewPostManager = (function(superClass) {
    extend(NewPostManager, superClass);

    function NewPostManager() {
      this.initialize_validation_rules = bind(this.initialize_validation_rules, this);
      this.initialize_tags = bind(this.initialize_tags, this);
      this.initialize_editor = bind(this.initialize_editor, this);
      this.update_hint = bind(this.update_hint, this);
      this.handle_preview_failure = bind(this.handle_preview_failure, this);
      this.handle_preview_success = bind(this.handle_preview_success, this);
      this.reset_path = bind(this.reset_path, this);
      this.finish_submit = bind(this.finish_submit, this);
      this.submit_post_as_draft = bind(this.submit_post_as_draft, this);
      this.$form = $("#new-post");
      this.tm = new quanto.TagManager();
      this.initialize_editor();
      this.initialize_validation_rules();
      this.initialize_tags();
      if ($('#titlebox').val() !== "") {
        $('.preview-post-link').prop('disabled', false);
      }
      this.$text_editor = $("#wmd-input");
      this.$text_editor.bind("focus", (function(_this) {
        return function() {
          $('#wmd-button-bar').removeClass('disabled');
          return _this.update_hint("body");
        };
      })(this));
      this.$text_editor.bind("focusout", (function(_this) {
        return function() {
          return _this.update_hint("focusout");
        };
      })(this));
      $("#titlebox").bind("focus", (function(_this) {
        return function() {
          return _this.update_hint("title");
        };
      })(this));
      $("#titlebox").bind("focusout", (function(_this) {
        return function() {
          return _this.update_hint("focusout");
        };
      })(this));
      quanto.on_click('.preview-post-link', (function(_this) {
        return function(e) {
          return _this.submit_post_as_draft();
        };
      })(this));
      this.$text_editor.on("focusout", function(e) {
        var $elem;
        $elem = $(quanto.get_src_element(e));
        if ($elem.val() !== "") {
          $(".wmd-button-bar").addClass("white");
          $('#wmd-button-group-add-backtest').addClass('white');
          return $elem.addClass("white");
        } else {
          $(".wmd-button-bar").removeClass("white");
          $('#wmd-button-group-add-backtest').removeClass('white');
          return $elem.removeClass("white");
        }
      });
      NewPostManager.__super__.constructor.call(this);
      this.$attachment_select = $('#attachment-select');
      this.$attachment_select.selectpicker();
      this.$attachment_select.val('Attach').selectpicker('refresh');
      this.$attachment_select.change((function(_this) {
        return function(e) {
          var clicked_elem;
          clicked_elem = _this.$attachment_select.find('option:selected').val();
          if (clicked_elem === 'Backtest') {
            $(document).trigger("insert_backtest_in_reply");
          } else if (clicked_elem === 'Notebook') {
            $(document).trigger("insert_notebook_in_reply");
          }
          return _this.$attachment_select.val('Attach').selectpicker('refresh');
        };
      })(this));
      if ($('#attach-nb-data').length > 0) {
        this.shared_from_notebook = true;
        this.attach_nb_data = $('#attach-nb-data').data();
        this.research_host_url = this.attach_nb_data['research_host_url'];
        this.add_attached_notebook(this.attach_nb_data['attach_nb_name']);
      }
    }

    NewPostManager.prototype.submit_post_as_draft = function() {
      var backtest_id, body, existing_post_id, tags, title;
      title = _.str.trim($("#titlebox").val());
      body = _.str.trim(this.$text_editor.val());
      tags = _.str.trim($("#tags-hidden-field").val());
      existing_post_id = _.str.trim($("#existing_post_id").val());
      backtest_id = _.str.trim($("#backtest-id").val());
      this.post_data = {
        title: title,
        body: body,
        tags: tags,
        existing_post_id: existing_post_id,
        backtest_id: backtest_id
      };
      this.before_submit();
      return false;
    };

    NewPostManager.prototype.finish_submit = function() {
      if ($("#post-id").length > 0) {
        this.post_data.existing_post_id = $("#post-id").val();
      }
      return $.ajax('/posts/submit', {
        type: "POST",
        data: this.post_data,
        dataType: "html",
        success: this.handle_preview_success,
        error: this.handle_preview_failure,
        async: false
      });
    };

    NewPostManager.prototype.reset_path = function() {
      return window.history.pushState({}, "", "/posts/new");
    };

    NewPostManager.prototype.handle_preview_success = function(response) {
      var qjr;
      qjr = new quanto.JsonResponse(response);
      if (qjr.ok()) {
        return window.location.href = qjr.data()['post_path'];
      } else {
        return console.log('failure!');
      }
    };

    NewPostManager.prototype.handle_preview_failure = function(response) {
      var msg;
      msg = this.get_error_msg(response);
      return quanto.show_error_popup("Error", msg);
    };

    NewPostManager.prototype.update_hint = function(hint_id) {
      if (hint_id === "body") {
        return $(".body-hint").fadeIn(200);
      } else if (hint_id === "title") {
        return $(".title-hint").fadeIn(200);
      } else if (hint_id === "focusout") {
        $(".input-hint").fadeOut(100);
        return $(".body-hint").fadeOut(100);
      }
    };

    NewPostManager.prototype.initialize_editor = function() {
      this.wmd_mgr = new quanto.wmdEditor({
        "show-attach": true
      });
      return this.wmd_mgr.editor.refreshPreview();
    };

    NewPostManager.prototype.initialize_tags = function() {
      var i, len, modal_elem, tag, tag_array, tags;
      this.tags_added_count = 0;
      tags = $('#tags-hidden-field').val();
      tags = tags.replace(/\"|\[|]|\s/g, '');
      tag_array = tags.split(',');
      if (tags !== "") {
        for (i = 0, len = tag_array.length; i < len; i++) {
          tag = tag_array[i];
          modal_elem = $('*[data-tag-id=' + tag + ']');
          modal_elem.addClass('selected');
          if (!modal_elem.data('tag-hidden')) {
            this.tags_added_count += 1;
          }
        }
        return this.tm.update_tags();
      }
    };

    NewPostManager.prototype.initialize_validation_rules = function() {
      var validator;
      return validator = this.$form.validate({
        onkeyup: function() {
          if (this.valid()) {
            return $('.preview-post-link').prop('disabled', false);
          } else {
            return $('.preview-post-link').prop('disabled', true);
          }
        },
        rules: {
          title: {
            required: true
          },
          body: {
            required: true
          }
        },
        errorPlacement: function(error, elem) {
          return true;
        }
      });
    };

    return NewPostManager;

  })(quanto.PostManagerBase);

}).call(this);
(function() {
  var InlineEditorControl, ListenerControl, PostManager,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; },
    extend = function(child, parent) { for (var key in parent) { if (hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; },
    hasProp = {}.hasOwnProperty,
    indexOf = [].indexOf || function(item) { for (var i = 0, l = this.length; i < l; i++) { if (i in this && this[i] === item) return i; } return -1; };

  quanto.PostManager = PostManager = (function(superClass) {
    extend(PostManager, superClass);

    function PostManager(preview) {
      this.get_validation_tooltip_text = bind(this.get_validation_tooltip_text, this);
      this.get_preview_link_text = bind(this.get_preview_link_text, this);
      this.clear_controls = bind(this.clear_controls, this);
      this.handle_clone_clicked = bind(this.handle_clone_clicked, this);
      this.init_pending_review_tooltip = bind(this.init_pending_review_tooltip, this);
      this.finish_submit = bind(this.finish_submit, this);
      this.mark_unsecure = bind(this.mark_unsecure, this);
      this.mark_secure = bind(this.mark_secure, this);
      this.delete_spam = bind(this.delete_spam, this);
      this.mark_spam = bind(this.mark_spam, this);
      this.mark_ham = bind(this.mark_ham, this);
      this.handle_reply_clicked = bind(this.handle_reply_clicked, this);
      this.handle_reply_from_modal = bind(this.handle_reply_from_modal, this);
      this.add_reply_html = bind(this.add_reply_html, this);
      this.initialize_reply_control = bind(this.initialize_reply_control, this);
      this.format_code = bind(this.format_code, this);
      this.get_plaintext_for_sharing = bind(this.get_plaintext_for_sharing, this);
      this.initialize_sharing = bind(this.initialize_sharing, this);
      this.initialize_embedded_notebook = bind(this.initialize_embedded_notebook, this);
      this.initialize_embedded_backtest = bind(this.initialize_embedded_backtest, this);
      this.handle_delete_clicked = bind(this.handle_delete_clicked, this);
      this.publish_post = bind(this.publish_post, this);
      this.dont_show_close_confirmation = bind(this.dont_show_close_confirmation, this);
      this.go_back_to_community = bind(this.go_back_to_community, this);
      var $target, backtest_widget, cm, hash, i, j, len, len1, notebook_widget, ref, ref1, tm;
      PostManager.__super__.constructor.call(this);
      this.$reply_placeholder = $(".reply-box-inactive");
      this.$replybox = $("#wmd-input");
      this.$replybutton = $("#reply-button");
      this.thread_id = $("#parent-post-id-val").val();
      this.$text_editor = this.$replybox;
      this.$submit_button = this.$replybutton;
      this.submit_text = "Reply";
      this.submitting_text = "Sending...";
      quanto.on_click("#reply-button", this.handle_reply_clicked);
      quanto.on_click("#reply-from-modal-button", this.handle_reply_from_modal);
      quanto.on_click(".clone-backtest-button", this.handle_clone_clicked);
      quanto.on_click(".submit-new-post-button", (function(_this) {
        return function(e) {
          return _this.publish_post();
        };
      })(this));
      quanto.on_click(".back-to-community", (function(_this) {
        return function(e) {
          return _this.go_back_to_community();
        };
      })(this));
      quanto.on_click(".edit-post", (function(_this) {
        return function(e) {
          return _this.dont_show_close_confirmation();
        };
      })(this));
      quanto.on_click(".cancel-post", (function(_this) {
        return function(e) {
          return _this.dont_show_close_confirmation();
        };
      })(this));
      quanto.on_click(".mark-ham-button", (function(_this) {
        return function(e) {
          return _this.mark_ham(e);
        };
      })(this));
      quanto.on_click(".mark-spam-link", (function(_this) {
        return function(e) {
          return _this.mark_spam(e);
        };
      })(this));
      quanto.on_click(".delete-spam-button", (function(_this) {
        return function(e) {
          return _this.delete_spam(e);
        };
      })(this));
      quanto.on_click(".mark-secure-link", (function(_this) {
        return function(e) {
          return _this.mark_secure(e);
        };
      })(this));
      quanto.on_click(".mark-unsecure-link", (function(_this) {
        return function(e) {
          return _this.mark_unsecure(e);
        };
      })(this));
      this.init_pending_review_tooltip();
      quanto.on_click(".disclaimer-minimized-wrapper .title", (function(_this) {
        return function(e) {
          var disclaimer, title;
          title = $(quanto.get_src_element(e));
          disclaimer = $(title).closest(".disclaimer-minimized-wrapper");
          return disclaimer.toggleClass('collapsed');
        };
      })(this));
      quanto.instances.backtest_summary_managers = [];
      ref = $(".backtest-widget");
      for (i = 0, len = ref.length; i < len; i++) {
        backtest_widget = ref[i];
        this.initialize_embedded_backtest($(backtest_widget));
      }
      ref1 = $(".nb-preview-widget");
      for (j = 0, len1 = ref1.length; j < len1; j++) {
        notebook_widget = ref1[j];
        this.initialize_embedded_notebook($(notebook_widget));
      }
      this.format_code();
      this.listener_control = new ListenerControl(this.thread_id);
      this.initialize_sharing();
      $('#reply-button').keypress(function(e) {
        if (e.keyCode === 13) {
          return $('#reply-button').click();
        }
      });
      if ($(".wmd-panel").length > 0) {
        this.initialize_reply_control();
      }
      if ((window.location.hash != null) && window.location.hash.length > 0) {
        hash = quanto.get_safe_window_hash();
        if (hash[0] === "#") {
          hash = hash.substr(1);
        }
        $target = $(".container[data-postid=" + hash + "]");
        if ($target.length > 0) {
          setTimeout(((function(_this) {
            return function() {
              return window.scrollTo(0, $target.offset().top - 55);
            };
          })(this)), 100);
        }
      }
      quanto.on_click(".delete-link", (function(_this) {
        return function(e) {
          return _this.handle_delete_clicked(e);
        };
      })(this));
      this.inline_editing_control = new InlineEditorControl();
      $('.link-to-original-disclaimer').on("click", function(e) {
        var href;
        href = $(quanto.get_src_element(e)).data('href');
        return $("html,body").animate({
          scrollTop: $("a[name=" + href + "]").offset().top
        }, 'slow');
      });
      if (preview) {
        tm = new quanto.TagManager();
        $(window).bind('beforeunload', function() {
          return 'This post has not been published.  Are you sure you want to leave without publishing?';
        });
      } else {
        cm = new quanto.ContentManager();
      }
      $(".badge.medal").tooltip({
        title: "This user is a Quantopian challenge winner.",
        container: '.post-metadata'
      });
    }

    PostManager.prototype.go_back_to_community = function() {
      var referrer;
      if (document.referrer === "") {
        quanto.go_to_community_home();
        return;
      }
      referrer = new URL(document.referrer);
      if (parent.history.length > 1 && document.referrer !== window.location.href && _.str.include(referrer.pathname, 'post') && referrer.hostname === window.location.hostname && document.referrer.indexOf("/posts/edit/") < 0) {
        return parent.history.back();
      } else {
        return quanto.go_to_community_home();
      }
    };

    PostManager.prototype.dont_show_close_confirmation = function() {
      return $(window).unbind('beforeunload');
    };

    PostManager.prototype.publish_post = function() {
      var data, i, len, new_tags, tag, tag_ids;
      $(window).unbind('beforeunload');
      data = {
        existing_post_id: $('#post-id').val()
      };
      new_tags = $('.current-tags').children('.tag.selected');
      if (new_tags.length > 0) {
        tag_ids = [];
        for (i = 0, len = new_tags.length; i < len; i++) {
          tag = new_tags[i];
          tag_ids.push($(tag).data('tag-id'));
        }
        data["tags"] = tag_ids.join(",");
      }
      return $.post("/posts/publish", data, (function(_this) {
        return function(response) {
          if (_this.sharing_backtest || _this.attached_backtest_id) {
            mixpanel.track("successfully shared algo", {}, (function() {
              var qjr;
              return qjr = new quanto.JsonResponse(response);
            }));
          } else {
            mixpanel.track("submitted new non-backtest post", {}, (function() {
              var qjr;
              return qjr = new quanto.JsonResponse(response);
            }));
          }
          if (response.status === "ok") {
            return window.location = response.data.post_path;
          }
        };
      })(this)).error((function(_this) {
        return function(jqxhr, status, errorThrown) {
          var msg;
          msg = _this.get_error_msg(jqxhr);
          return quanto.show_error_popup("Error", msg);
        };
      })(this));
    };

    PostManager.prototype.handle_delete_clicked = function(e) {
      var $link, $post, callback, noun, post_id;
      $link = $(quanto.get_src_element(e));
      $post = $link.closest(".post-container");
      post_id = $post.data("post-id");
      if (post_id != null) {
        callback = (function(_this) {
          return function() {
            var data;
            data = {
              id: post_id
            };
            return $.post("/posts/delete_post", data, function(response) {
              var qjr;
              qjr = new quanto.JsonResponse(response);
              if (qjr.ok()) {
                mixpanel.track("Post deleted");
                return $post.remove();
              }
            }).error(function(jqxhr, status, errorThrown) {
              return alert("There was a problem deleting this post.");
            });
          };
        })(this);
        if ($post.hasClass("response-container")) {
          noun = "response";
        } else {
          noun = "post";
        }
        return quanto.show_confirmation_popup("Confirm", "Delete this " + noun + "?", "Delete", callback);
      }
    };

    PostManager.prototype.initialize_embedded_backtest = function($backtest_widget) {
      var backtest_id, migrated_backtest_id;
      backtest_id = $backtest_widget.data("backtest-id");
      migrated_backtest_id = $backtest_widget.data("migrated-backtest-id");
      if (backtest_id != null) {
        return quanto.instances.backtest_summary_managers.push(new quanto.BacktestSummaryManager($backtest_widget, backtest_id, migrated_backtest_id));
      }
    };

    PostManager.prototype.initialize_embedded_notebook = function($cur_widget) {
      var $clone_nb_button, $full_nb_button, $wrapper, clone_tooltip_text, full_iframe_mgr, iframe_mgr;
      full_iframe_mgr = new quanto.NotebookIframeManager($cur_widget.find('.full-notebook-iframe'), true);
      iframe_mgr = new quanto.NotebookIframeManager($cur_widget.find('.nb-preview-iframe'), false, full_iframe_mgr);
      $clone_nb_button = $cur_widget.find('.clone-notebook-button:visible');
      $full_nb_button = $cur_widget.find('.full-notebook-button');
      clone_tooltip_text = "Make a copy of this research notebook so you can explore and modify it.";
      if ($clone_nb_button.hasClass('mobile')) {
        clone_tooltip_text = "Cloning on small mobile devices is not currently supported. Login on a larger device to " + "interact with this notebook.";
      }
      $wrapper = $cur_widget.find('.clone-notebook-wrapper');
      $wrapper.tooltip({
        title: clone_tooltip_text,
        trigger: "hover",
        placement: "top"
      });
      $wrapper.on('show.bs.tooltip', (function(_this) {
        return function(e) {
          if (indexOf.call(document.documentElement, 'ontouchstart') >= 0) {
            return e.preventDefault();
          }
        };
      })(this));
      $clone_nb_button.click((function(_this) {
        return function(e) {
          var $btn;
          $btn = $(quanto.get_src_element(e));
          $btn.html("Cloning...").addClass("disabled");
          return setTimeout(function() {
            return $btn.html("Clone Notebook").removeClass("disabled");
          }, 1000);
        };
      })(this));
      return $full_nb_button.click((function(_this) {
        return function(e) {
          iframe_mgr.show_full_notebook_on_the_forums();
          return mixpanel.track("view notebook clicked", {
            "thread_id": _this.thread_id,
            "post_id": $cur_widget.data('post_id')
          });
        };
      })(this));
    };

    PostManager.prototype.initialize_sharing = function() {
      $(".facebook-button").on("click", (function(_this) {
        return function(e) {
          return FB.ui({
            method: 'feed',
            caption: $("#social_post_author").val(),
            link: $("#social_fb_post_link").val(),
            name: $.trim($("title").html()),
            description: _this.get_plaintext_for_sharing(500),
            picture: $("#social_post_image").val()
          }, function(response) {
            if (response != null) {
              return mixpanel.track("shared thread", {
                "medium": "facebook"
              });
            } else {
              return alert("Sorry, there was a problem sharing this thread on Facebook.");
            }
          });
        };
      })(this));
      $(".linkedin-button").on("click", (function(_this) {
        return function(e) {
          var left, top, url;
          url = $(quanto.get_src_element(e)).data("share-url");
          top = (screen.height / 2) - 200;
          left = (screen.width / 2) - 300;
          url += "&summary=" + (_this.get_plaintext_for_sharing(500));
          return window.open(url, "linkedin", "menubar=no,titlebar=no,height=370,width=600,left=" + left + ",top=" + top);
        };
      })(this));
      return twttr.ready((function(_this) {
        return function(twttr) {
          return twttr.events.bind("tweet", function(event) {
            return mixpanel.track("shared thread", {
              "medium": "twitter"
            });
          });
        };
      })(this));
    };

    PostManager.prototype.get_plaintext_for_sharing = function(length) {
      var error, text, text_array;
      if (length == null) {
        length = 500;
      }
      text_array = [];
      $(".body-text-container").find("p").each((function(_this) {
        return function(idx, elem) {
          return text_array.push($(elem).html());
        };
      })(this));
      try {
        text = text_array.join(" ");
        text = text.replace(/<(?:.|\n)*?>/gm, '');
        text = _.str.truncate(text, length);
      } catch (error1) {
        error = error1;
        text = "(Could not get preview)";
      }
      return text;
    };

    PostManager.prototype.format_code = function() {
      $("pre code").addClass("prettyprint");
      return window.prettyPrint();
    };

    PostManager.prototype.initialize_reply_control = function() {
      this.wmd_mgr = new quanto.wmdEditor({
        "show-attach": true
      });
      this.$attachment_select = $('#attachment-select');
      this.$panel = $(".wmd-panel");
      this.$reply_placeholder.on("mousedown", (function(_this) {
        return function(e) {
          _this.$reply_placeholder.addClass("hidden");
          _this.$panel.removeClass("hidden");
          $(".post-reply .submit").removeClass("hidden");
          return _this.$panel.animate({
            height: "160px"
          }, 350).queue(function(next) {
            _this.$replybox.height(128).removeClass("hidden").focus();
            return _this.$panel.css("height", "auto");
          });
        };
      })(this));
      this.$attachment_select.selectpicker({
        dropupAuto: false
      });
      this.$attachment_select.val('Attach').selectpicker('refresh');
      this.$attachment_select.change((function(_this) {
        return function(e) {
          var clicked_elem;
          clicked_elem = _this.$attachment_select.find('option:selected').val();
          if (clicked_elem === 'Backtest') {
            $(document).trigger("insert_backtest_in_reply");
          } else if (clicked_elem === 'Notebook') {
            $(document).trigger("insert_notebook_in_reply");
          }
          return _this.$attachment_select.val('Attach').selectpicker('refresh');
        };
      })(this));
      if (this.$replybox.val()) {
        return this.$reply_placeholder.trigger("mousedown");
      }
    };

    PostManager.prototype.add_reply_html = function(html) {
      var $cur_reply, $embedded_backtest, $embedded_notebook, $html, response_count;
      $html = $("<div>" + html + "</div>");
      html = $html.html();
      $(".replies").append(html);
      quanto.date.render_all_date_values();
      this.format_code();
      response_count = $(".post-response").length;
      if (response_count === 1) {
        $(".reply-title").html("1 response");
      } else if (response_count > 0) {
        $(".reply-title").html(response_count + " responses");
      } else {
        $(".reply-title").html("");
      }
      $cur_reply = $(".replies .response-container").last();
      $embedded_backtest = $cur_reply.find(".backtest-widget").not(".backtest-loaded");
      if ($embedded_backtest.length > 0) {
        this.initialize_embedded_backtest($embedded_backtest);
      }
      $embedded_notebook = $cur_reply.find(".nb-preview-widget");
      if ($embedded_notebook.length > 0) {
        this.initialize_embedded_notebook($embedded_notebook);
      }
      quanto.load_async_images();
      return setTimeout(((function(_this) {
        return function() {
          var error;
          try {
            return MathJax.Hub.Queue(["Typeset", MathJax.Hub, $cur_reply[0]]);
          } catch (error1) {
            error = error1;
            return console.log("Could not mathjax typeset reply: " + error);
          }
        };
      })(this)), 100);
    };

    PostManager.prototype.handle_reply_from_modal = function(e) {
      $("#preview_reply_modal").modal("hide");
      return this.handle_reply_clicked();
    };

    PostManager.prototype.handle_reply_clicked = function(e) {
      var replytext;
      replytext = _.str.trim(this.$replybox.val());
      if (replytext.length === 0) {
        $("#submit-error").html("Enter some text in your reply.").removeClass("hidden");
        return;
      } else {
        $("#submit-error").html("").addClass("hidden");
      }
      this.disable_controls();
      this.post_data = {
        parent_post_id: this.thread_id,
        text: replytext
      };
      this.$replybutton.addClass('disabled');
      return this.before_submit();
    };

    PostManager.prototype.mark_ham = function(e) {
      var $clicked, post_id;
      $clicked = $(quanto.get_src_element(e));
      post_id = $clicked.data("post-id");
      return $.post("/posts/mark_ham", {
        id: post_id
      }, (function(_this) {
        return function(response) {
          var qjr;
          qjr = new quanto.JsonResponse(response);
          if (qjr.ok()) {
            return window.location.reload(true);
          } else {
            return quanto.show_error_popup("Error", "Something went wrong.");
          }
        };
      })(this)).error((function(_this) {
        return function(response) {
          return quanto.show_error_popup("Error", "Something went wrong.");
        };
      })(this));
    };

    PostManager.prototype.mark_spam = function(e) {
      var $clicked, $post, callback, post_id;
      $clicked = $(quanto.get_src_element(e));
      $post = $clicked.closest(".post-container");
      post_id = $post.data("post-id");
      callback = (function(_this) {
        return function() {
          return $.post("/posts/mark_spam", {
            id: post_id
          }, function(response) {
            var qjr;
            qjr = new quanto.JsonResponse(response);
            if (qjr.ok()) {
              return window.location.reload(true);
            } else {
              return quanto.show_error_popup("Error", "Something went wrong.");
            }
          }).error(function(response) {
            return quanto.show_error_popup("Error", "Something went wrong.");
          });
        };
      })(this);
      return quanto.show_confirmation_popup("Mark Spam", "Mark this post as spam?", "Mark Spam", callback);
    };

    PostManager.prototype.delete_spam = function(e) {
      var $clicked, post_id;
      $clicked = $(quanto.get_src_element(e));
      post_id = $clicked.data("post-id");
      return $.post("/posts/delete_post", {
        id: post_id
      }, (function(_this) {
        return function(response) {
          var qjr;
          qjr = new quanto.JsonResponse(response);
          if (!qjr.redirect()) {
            return quanto.show_error_popup("Error", "Something went wrong.");
          }
        };
      })(this)).error((function(_this) {
        return function(jqxhr, status, errorThrown) {
          return quanto.show_error_popup("Error", "Something went wrong.");
        };
      })(this));
    };

    PostManager.prototype.mark_secure = function(e) {
      var $link, $post, callback, noun, post_id;
      $link = $(quanto.get_src_element(e));
      $post = $link.closest(".post-container");
      post_id = $post.data("post-id");
      if (post_id != null) {
        callback = (function(_this) {
          return function() {
            var data;
            data = {
              id: post_id
            };
            return $.post("/posts/mark_secure", {
              id: post_id
            }, function(response) {
              var qjr;
              qjr = new quanto.JsonResponse(response);
              if (qjr.ok()) {
                return window.location.reload(true);
              } else {
                return quanto.show_error_popup("Error", "Something went wrong.");
              }
            }).error(function(response) {
              var msg;
              msg = _this.get_error_msg(response);
              return quanto.show_error_popup("Error", msg);
            });
          };
        })(this);
        if ($post.hasClass("response-container")) {
          noun = "response";
        } else {
          noun = "post";
        }
        return quanto.show_confirmation_popup("Confirm", "Approving this " + noun + " will make it public and will notify subscribed users. Do you want to proceed?", "Approve", callback);
      }
    };

    PostManager.prototype.mark_unsecure = function(e) {
      var $link, $post, callback, noun, post_id;
      $link = $(quanto.get_src_element(e));
      $post = $link.closest(".post-container");
      post_id = $post.data("post-id");
      if (post_id != null) {
        callback = (function(_this) {
          return function() {
            var data;
            data = {
              id: post_id
            };
            return $.post("/posts/mark_unsecure", {
              id: post_id
            }, function(response) {
              var qjr;
              qjr = new quanto.JsonResponse(response);
              if (qjr.ok()) {
                return window.location.reload(true);
              } else {
                return quanto.show_error_popup("Error", "Something went wrong.");
              }
            }).error(function(response) {
              return quanto.show_error_popup("Error", "Something went wrong.");
            });
          };
        })(this);
        if ($post.hasClass("response-container")) {
          noun = "response";
        } else {
          noun = "post";
        }
        return quanto.show_confirmation_popup("Confirm", "Reporting this " + noun + " will remove it from the forum, and will notify our Security team. Do you want to proceed?", "Report", callback);
      }
    };

    PostManager.prototype.finish_submit = function() {
      $.post("/posts/submit_reply", this.post_data, (function(_this) {
        return function(response) {
          var qjr;
          mixpanel.track("post reply submitted");
          qjr = new quanto.JsonResponse(response);
          _this.$replybutton.removeClass('disabled');
          if (qjr.ok()) {
            _this.add_reply_html(qjr.html());
            _this.clear_controls();
            _this.enable_controls();
            _this.init_pending_review_tooltip();
            if ((_this.attached_backtest_id != null) || (_this.attached_notebook != null)) {
              return _this.remove_attachment();
            }
          }
        };
      })(this)).error((function(_this) {
        return function(jqxhr, status, errorThrown) {
          var msg;
          if (quanto.is_not_logged_in_error(jqxhr)) {
            alert("You must be logged in.");
          } else {
            msg = _this.get_error_msg(jqxhr);
            quanto.show_error_popup("Error", msg);
          }
          return _this.enable_controls();
        };
      })(this));
      return this.$replybutton.prop('disabled', false);
    };

    PostManager.prototype.init_pending_review_tooltip = function() {
      return $('.pending-review').tooltip({
        animation: false,
        title: "This comment is under review. Once it is approved, it will become public.",
        trigger: "hover",
        delay: {
          show: 500,
          hide: 100
        },
        placement: "top"
      });
    };

    PostManager.prototype.handle_clone_clicked = function(e) {
      var $btn, $widget, algo_id, backtest_id, data, post_id;
      $btn = $(quanto.get_src_element(e));
      $btn.html("Cloning...").addClass("disabled");
      $widget = $btn.closest(".backtest-widget");
      algo_id = $widget.data("algo-id");
      backtest_id = $widget.data("backtest-id");
      post_id = $widget.data("post-id");
      data = {
        id: algo_id,
        post_id: post_id,
        backtest_id: backtest_id
      };
      return $.post("/algorithms/clone", data, (function(_this) {
        return function(response) {
          var qjr;
          mixpanel.track("new algo", {
            "type": "cloned"
          });
          qjr = new quanto.JsonResponse(response);
          if (!qjr.redirect() && !qjr.ok()) {
            $btn.html("Clone Algorithm").removeClass("disabled");
            return quanto.show_error_popup("There was an error cloning this algorithm.");
          }
        };
      })(this));
    };

    PostManager.prototype.clear_controls = function() {
      this.$replybox.val("");
      this.wmd_mgr.editor.refreshPreview();
      $("#reply-link").trigger("click");
      return setTimeout(((function(_this) {
        return function() {
          return _this.$replybox.focus();
        };
      })(this)), 10);
    };

    PostManager.prototype.get_preview_link_text = function() {
      return "Preview";
    };

    PostManager.prototype.get_validation_tooltip_text = function() {
      return "Enter some text for this reply";
    };

    return PostManager;

  })(quanto.PostManagerBase);

  InlineEditorControl = (function() {
    function InlineEditorControl() {
      this.cancel_edit_ui = bind(this.cancel_edit_ui, this);
      this.handle_update_post_clicked = bind(this.handle_update_post_clicked, this);
      this.handle_cancel_update = bind(this.handle_cancel_update, this);
      this.handle_edit_clicked = bind(this.handle_edit_clicked, this);
      this.wmd_editors = {};
      quanto.on_click(".edit-link.inplace", (function(_this) {
        return function(e) {
          return _this.handle_edit_clicked(e);
        };
      })(this));
      quanto.on_click(".update-post-button", (function(_this) {
        return function(e) {
          return _this.handle_update_post_clicked(e);
        };
      })(this));
      quanto.on_click(".cancel-update-button", (function(_this) {
        return function(e) {
          return _this.handle_cancel_update(e);
        };
      })(this));
    }

    InlineEditorControl.prototype.handle_edit_clicked = function(e) {
      var $edit_controls, $link, $post, post_id;
      $link = $(quanto.get_src_element(e));
      $post = $link.closest(".post-container");
      post_id = $post.data("post-id");
      $edit_controls = $post.find(".edit-body-controls");
      $post.find(".response-text").hide();
      $edit_controls.show();
      if (!$edit_controls.hasClass("wmd-done")) {
        this.wmd_editors[post_id] = new quanto.wmdEditor({
          "show-attach": false,
          "postfix": "-" + post_id
        });
        return $edit_controls.addClass("wmd-done");
      }
    };

    InlineEditorControl.prototype.handle_cancel_update = function(e) {
      var $button, $post;
      $button = $(quanto.get_src_element(e));
      $post = $button.closest(".post-container");
      return this.cancel_edit_ui($post);
    };

    InlineEditorControl.prototype.handle_update_post_clicked = function(e) {
      var $button, $post, data, post_id;
      $button = $(quanto.get_src_element(e));
      $post = $button.closest(".response-container");
      post_id = $post.data("post-id");
      data = {
        id: post_id,
        new_body: $("#wmd-input-" + post_id).val()
      };
      return $.post("/posts/update_post", data, (function(_this) {
        return function(response) {
          var new_html, qjr;
          qjr = new quanto.JsonResponse(response);
          if (qjr.ok()) {
            mixpanel.track("Post edited");
            new_html = qjr.data()["new_html"];
            if (new_html != null) {
              $post.find(".response-text-container").html(new_html);
            }
            return _this.cancel_edit_ui($post);
          }
        };
      })(this)).error((function(_this) {
        return function(jqxhr, status, errorThrown) {
          return alert("There was a problem updating your post.");
        };
      })(this));
    };

    InlineEditorControl.prototype.cancel_edit_ui = function($post) {
      $post.find(".response-text").show();
      return $post.find(".edit-body-controls").hide();
    };

    return InlineEditorControl;

  })();

  ListenerControl = (function() {
    function ListenerControl(thread_id) {
      this.render = bind(this.render, this);
      this.toggle_listener = bind(this.toggle_listener, this);
      this.initialize = bind(this.initialize, this);
      this.$listeners_container = $(".listeners-control");
      if (this.$listeners_container.length === 0) {
        return;
      }
      this.thread_id = thread_id;
      this.$button = $("#listen-button");
      this.$listeners_label = $(".listeners-count");
      this.initialize();
    }

    ListenerControl.prototype.initialize = function() {
      var data_field, initial_count, initial_listening;
      this.listening = false;
      data_field = $("#listening-data");
      initial_listening = data_field.data("listening");
      initial_count = data_field.data("count");
      this.listening = initial_listening;
      this.render(initial_count);
      return quanto.on_click("#listen-button", this.toggle_listener);
    };

    ListenerControl.prototype.toggle_listener = function() {
      var data;
      data = {
        "id": this.thread_id
      };
      if (this.listening) {
        return $.post("/posts/remove_listener", data, (function(_this) {
          return function(response) {
            var count, qjr;
            _this.listening = false;
            qjr = new quanto.JsonResponse(response);
            count = qjr.data().count;
            return _this.render(count, true);
          };
        })(this));
      } else {
        return $.post("/posts/add_listener", data, (function(_this) {
          return function(response) {
            var count, qjr;
            _this.listening = true;
            qjr = new quanto.JsonResponse(response);
            count = qjr.data().count;
            return _this.render(count, true);
          };
        })(this));
      }
    };

    ListenerControl.prototype.render = function(count, show_tooltip_immediately) {
      if (show_tooltip_immediately == null) {
        show_tooltip_immediately = false;
      }
      if (this.listening) {
        this.$button.addClass("active");
        this.$button.find(".listen-label").html("Listening");
        this.$button.tooltip("destroy");
        this.$button.tooltip({
          title: "You will receive email updates for this thread.",
          container: 'body'
        });
      } else {
        this.$button.removeClass("active");
        this.$button.find(".listen-label").html("Listen");
        this.$button.tooltip("destroy");
        this.$button.tooltip({
          title: "Click to receive email updates for this thread.",
          container: 'body'
        });
      }
      if (count != null) {
        if (count === 1) {
          this.$listeners_label.html("1 person listening");
        } else {
          this.$listeners_label.html(count + " people listening");
        }
      }
      this.$listeners_container.removeClass("hidden");
      if (show_tooltip_immediately) {
        return this.$button.tooltip("show");
      }
    };

    return ListenerControl;

  })();

}).call(this);
(function() {
  var TagManager,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

  quanto.TagManager = TagManager = (function() {
    function TagManager() {
      this.update_all_tags_in_modal = bind(this.update_all_tags_in_modal, this);
      this.update_add_tag_modal_from_search_box = bind(this.update_add_tag_modal_from_search_box, this);
      this.update_add_tags_mobile = bind(this.update_add_tags_mobile, this);
      this.initialize_add_tag_modal = bind(this.initialize_add_tag_modal, this);
      this.select_tags_for_search = bind(this.select_tags_for_search, this);
      this.update_tags = bind(this.update_tags, this);
      this.add_remove_tag = bind(this.add_remove_tag, this);
      this.add_tags = bind(this.add_tags, this);
      this.tags_added_count = 0;
      quanto.on_click(".add-tags", (function(_this) {
        return function(e) {
          return _this.add_tags(e);
        };
      })(this));
      quanto.on_click(".addable", (function(_this) {
        return function(e) {
          return _this.add_remove_tag(e);
        };
      })(this));
      quanto.on_click("#save-tags-button", (function(_this) {
        return function(e) {
          return _this.update_tags();
        };
      })(this));
      this.tag_template = Handlebars.compile("{{{wrapper-begin}}}<div class='tag {{class}}' data-tag-id='{{id}}'>{{tag}}</div>{{{wrapper-end}}}");
    }

    TagManager.prototype.add_tags = function(e) {
      var elem;
      elem = $(quanto.get_src_element(e));
      $('#add-tags-to-post-modal').modal("show");
      if ($(elem).hasClass('select-tags')) {
        this.update_add_tag_modal_from_search_box();
      }
    };

    TagManager.prototype.add_remove_tag = function(e) {
      var $elem, $modal_elem, featured_selected, id;
      $elem = $(quanto.get_src_element(e));
      if ($elem.parent().hasClass('current-tags') && !$elem.hasClass('suggested')) {
        id = $elem.data('tag-id');
        $modal_elem = $('*[data-tag-id=' + id + ']');
        $modal_elem.removeClass('selected');
        if ($elem.html() !== "Featured") {
          this.tags_added_count -= 1;
        }
        this.update_tags();
        return;
      }
      if ($elem.hasClass('suggested') && $elem.parent().parent().hasClass('suggested-tags-wrapper')) {
        id = $elem.data('tag-id');
        $modal_elem = $('.modal [data-tag-id=' + id + ']');
        $modal_elem.toggleClass('selected');
      }
      if ($elem.html() === "Featured") {

      } else if ($elem.hasClass('selected')) {
        this.tags_added_count -= 1;
      } else if (!$elem.hasClass('selected') && this.tags_added_count < 5 || $elem.hasClass('suggested')) {
        this.tags_added_count += 1;
      } else {
        $('#add-tags-to-post-modal').find('.subtitle').toggleClass('shake');
        return;
      }
      $elem.toggleClass('selected');
      featured_selected = $('#add-tags-to-post-modal').find('.addable').filter(":contains('Featured')").hasClass('selected');
      if (this.tags_added_count === 0 && !featured_selected) {
        return $('#save-tags-button').prop("disabled", true);
      } else {
        return $('#save-tags-button').prop("disabled", false);
      }
    };

    TagManager.prototype.update_tags = function() {
      var $selected_tags, array, html, i, id, len, selected, suggested, tag;
      $("#add-tags-button").hide();
      $(".tags :not(.suggested)").remove();
      $('.new-post').find('.current-tags').empty();
      $selected_tags = $(".tag.selected");
      array = [];
      for (i = 0, len = $selected_tags.length; i < len; i++) {
        selected = $selected_tags[i];
        tag = $(selected).html();
        id = $(selected).data('tag-id');
        array.push(id);
        suggested = '';
        if (!$(selected).hasClass('suggested')) {
          html = this.tag_template({
            "class": "addable selected",
            "id": id,
            "tag": tag
          });
          $('.current-tags').append(html);
        }
      }
      if ($(".current-tags").children().length === 0) {
        $("#add-tags-button").show();
        $(".current-tags").hide();
      } else {
        if (!$(".current-tags").parent().hasClass('suggested-tags-wrapper')) {
          $(".current-tags").append("<div class='tag add-or-edit-tag add-tags'>Add/Edit</div>");
        }
        $(".current-tags").show();
      }
      if (array === []) {
        array = "";
      }
      return $('#tags-hidden-field').val(array.toString());
    };

    TagManager.prototype.select_tags_for_search = function(container) {
      var $selected_tags, current_tags, free_text, i, j, len, len1, search_box, selected, tag, tag_string;
      search_box = $('.wrapper').find('#search-box');
      free_text = search_box.val();
      current_tags = free_text.match(/[^[\]]+(?=])/g);
      if (current_tags !== null) {
        for (i = 0, len = current_tags.length; i < len; i++) {
          tag = current_tags[i];
          free_text = free_text.replace("[" + tag + "]", " ");
        }
      }
      tag_string = "";
      $selected_tags = $(container).find(".tag.selected");
      for (j = 0, len1 = $selected_tags.length; j < len1; j++) {
        selected = $selected_tags[j];
        tag = $(selected).html();
        tag_string += "[" + tag + "] ";
      }
      tag_string += free_text.trim();
      search_box.val(tag_string);
      if (tag_string === "") {
        return search_box.css('width', '100%');
      } else {
        return $(".current-tags").show();
      }
    };

    TagManager.prototype.initialize_add_tag_modal = function() {
      var i, len, tag, tag_array, tags;
      tags = $('.page-title').data('tag');
      if (tags !== "") {
        tag_array = tags.split(",");
        for (i = 0, len = tag_array.length; i < len; i++) {
          tag = tag_array[i];
          $('#add-tags-to-post-modal').find(':contains(' + tag + ')').addClass('selected');
          this.tags_added_count += 1;
        }
      }
      if (this.tags_added_count === 0) {
        return $('#save-tags-button').prop("disabled", true);
      }
    };

    TagManager.prototype.update_add_tags_mobile = function() {
      var i, len, results, tag, tag_array, tags;
      tags = $('.page-title').data('tag');
      if (tags !== "") {
        tag_array = tags.split(",");
        results = [];
        for (i = 0, len = tag_array.length; i < len; i++) {
          tag = tag_array[i];
          $('.mobile-advanced-search-options').find(':contains(' + tag + ')').addClass('selected');
          results.push(this.tags_added_count += 1);
        }
        return results;
      }
    };

    TagManager.prototype.update_add_tag_modal_from_search_box = function() {
      var i, len, regExp, results, t, tag, tags, text;
      $('#add-tags-to-post-modal').find('.selected').removeClass('selected');
      regExp = /\[(.*?)\]/g;
      text = $('#search-box').val();
      if (text !== "") {
        tags = text.match(regExp);
        if (tags !== null) {
          results = [];
          for (i = 0, len = tags.length; i < len; i++) {
            tag = tags[i];
            t = tag.substring(1, tag.length - 1);
            results.push($('#add-tags-to-post-modal').find(':contains(' + t + ')').addClass('selected'));
          }
          return results;
        }
      }
    };

    TagManager.prototype.update_all_tags_in_modal = function(all_tags) {
      var args, col, col_div, col_length, i, index, j, k, offset, ref, ref1, ref2, ref3, row, tag, tag_index;
      offset = (ref = all_tags.length % 4 !== 0) != null ? ref : {
        1: 0
      };
      col_length = Math.floor(all_tags.length / 4) + offset;
      for (col = i = 0; i < 3; col = ++i) {
        col_div = $('<div class="col"></div>');
        for (row = j = 0, ref1 = col_length; 0 <= ref1 ? j < ref1 : j > ref1; row = 0 <= ref1 ? ++j : --j) {
          tag_index = (col * col_length) + row;
          tag = all_tags[tag_index];
          args = {
            "class": "addable clickable",
            "id": tag["_id"]['$oid'],
            "tag": tag["name"],
            "wrapper-begin": '<div class="tag-wrapper">',
            "wrapper-end": '</div>'
          };
          tag = this.tag_template(args);
          col_div.append(tag);
        }
        $('.all-tags').append(col_div);
      }
      col_div = $('<div class="col"></div>');
      if (tag_index > 0 && all_tags.length > 0) {
        for (index = k = ref2 = tag_index + 1, ref3 = all_tags.length; ref2 <= ref3 ? k < ref3 : k > ref3; index = ref2 <= ref3 ? ++k : --k) {
          tag = all_tags[index];
          args = {
            "class": "addable clickable",
            "id": tag["_id"]['$oid'],
            "tag": tag["name"],
            "wrapper-begin": '<div class="tag-wrapper">',
            "wrapper-end": '</div>'
          };
          tag = this.tag_template(args);
          col_div.append(tag);
        }
      }
      return $('.all-tags').append(col_div);
    };

    return TagManager;

  })();

}).call(this);
(function() {
  var QuantoWmdEditor;

  quanto.wmdEditor = QuantoWmdEditor = (function() {
    function QuantoWmdEditor(options) {
      var keystroke, postfix;
      if (options == null) {
        options = {};
      }
      this.converter = Markdown.getSanitizingConverter();
      this.editor = new Markdown.Editor(this.converter, options["postfix"]);
      this.editor.run();
      postfix = options["postfix"] || "";
      $("#wmd-button-row" + postfix + " button").attr("tabIndex", -1);
      if ((options["show-attach"] != null) && options["show-attach"]) {
        $("#wmd-button-group-add-backtest" + postfix).removeClass("hidden");
      } else {
        $("#wmd-button-group-add-backtest" + postfix).remove();
      }
      if (quanto.is_mac()) {
        keystroke = "Cmd";
        $(".wmd-quote-button").tooltip({
          title: "Blockquote (" + keystroke + "-Shift-9)",
          container: 'body'
        });
        Mousetrap.bindGlobal('command+shift+9', function(e) {
          if (e.target === $('.wmd-input')[0]) {
            return $('#wmd-quote-button').click();
          }
        });
        Mousetrap.bindGlobal('command+shift+z', function(e) {
          if (e.target === $('.wmd-input')[0]) {
            return $('#wmd-redo-button').click();
          }
        });
      } else {
        keystroke = "Ctrl";
        $(".wmd-quote-button").tooltip({
          title: "Blockquote (" + keystroke + "-Q)",
          container: 'body'
        });
        Mousetrap.bindGlobal('ctrl+shift+z', function(e) {
          if (e.target === $('.wmd-input')[0]) {
            return $('#wmd-redo-button').click();
          }
        });
      }
      $(".wmd-bold-button").tooltip({
        title: "Bold (" + keystroke + "-B)",
        container: 'body'
      });
      $(".wmd-italic-button").tooltip({
        title: "Italic (" + keystroke + "-I)",
        container: 'body'
      });
      $(".wmd-link-button").tooltip({
        title: "Link (" + keystroke + "-L)",
        container: 'body'
      });
      $(".wmd-code-button").tooltip({
        title: "Code Sample (" + keystroke + "-K)",
        container: 'body'
      });
      $(".wmd-olist-button").tooltip({
        title: "Numbered List (" + keystroke + "-O)",
        container: 'body'
      });
      $(".wmd-ulist-button").tooltip({
        title: "Bulleted List (" + keystroke + "-U)",
        container: 'body'
      });
      $(".wmd-undo-button").tooltip({
        title: "Undo (" + keystroke + "-Z)",
        container: 'body'
      });
      $(".wmd-redo-button").tooltip({
        title: "Redo (" + keystroke + "-Shift-Z)",
        container: 'body'
      });
      this.converter.hooks.chain("postConversion", (function(_this) {
        return function(text) {
          if (text.length === 0) {
            return "<em class='gray'>(No text)</em>";
          } else {
            return text;
          }
        };
      })(this));
      this.converter.hooks.chain("postConversion", (function(_this) {
        return function(html) {
          var $code_block, $code_blocks, $html, code_block, i, len;
          $html = $("<div>" + html + "</div>");
          $code_blocks = $html.find("code");
          if ($code_blocks.length > 0) {
            $code_blocks.addClass("prettyprint");
            $code_blocks.wrap("<pre />");
            for (i = 0, len = $code_blocks.length; i < len; i++) {
              code_block = $code_blocks[i];
              $code_block = $(code_block);
              html = $code_block.html();
              if (_.str.startsWith(html, "\n")) {
                $code_block.html(html.substr(1));
              }
            }
          }
          return $html.html();
        };
      })(this));
    }

    return QuantoWmdEditor;

  })();

}).call(this);
(function() {
  var NotebookIframeManager,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

  quanto.NotebookIframeManager = NotebookIframeManager = (function() {
    function NotebookIframeManager($iframe_elem, view_full, full_notebook_manager) {
      if (view_full == null) {
        view_full = false;
      }
      this.fit_to_contents = bind(this.fit_to_contents, this);
      this.receive_post_message = bind(this.receive_post_message, this);
      this.show_full_notebook_on_the_forums = bind(this.show_full_notebook_on_the_forums, this);
      this.send_post_message = bind(this.send_post_message, this);
      this.show_error = bind(this.show_error, this);
      this.$iframe_elem = $iframe_elem;
      this.view_full = view_full;
      this.nb_preview_url = quanto_data.nb_preview_url;
      this.received_iframe_message = false;
      this.$nb_widget = this.$iframe_elem.closest('.nb-preview-area');
      this.$loading_area = this.$nb_widget.find('.progress-area');
      this.$error_area = this.$nb_widget.find('.error-area');
      this.$iframe_wrapper = this.$nb_widget.find('.nb-preview-wrapper');
      this.$full_notebook_button = this.$nb_widget.closest('.nb-preview-widget').find('.full-notebook-button');
      this.$full_notebook_manager = full_notebook_manager;
      this.$delayed_load_controls = this.$nb_widget.find(".delay-load-controls");
      this.$delayed_load_label = this.$nb_widget.find(".delay-load-label");
      this.delay_load = this.$iframe_elem.hasClass("delayed-load");
      this.delay_load_triggered = false;
      this.iframe_window = this.$iframe_elem[0].contentWindow;
      window.addEventListener("message", this.receive_post_message, false);
      if (!this.delay_load) {
        this.timeout_id = setTimeout((function(_this) {
          return function() {
            if (!_this.received_iframe_message) {
              return _this.send_post_message({
                event: 'get_height'
              });
            }
          };
        })(this), 2000);
      }
      this.$iframe_elem.load((function(_this) {
        return function() {
          if (_this.$iframe_elem.attr("src") == null) {
            return;
          }
          _this.iframe_loaded = true;
          if (_this.timeout_id != null) {
            clearTimeout(_this.timeout_id);
          }
          if (_this.delay_load_triggered) {
            _this.get_height_count = 0;
            _this.resize_window_timeout_id = setInterval((function() {
              try {
                _this.send_post_message({
                  event: 'get_height'
                });
                clearInterval(_this.resize_window_timeout_id);
              } catch (error) {
                _this.get_height_count += 1;
              }
              if (_this.get_height_count > 5) {
                return clearInterval(_this.resize_window_timeout_id);
              }
            }), 500);
          }
          if (!_this.view_full) {
            return setTimeout(function() {
              if (!_this.received_iframe_message) {
                return _this.show_error();
              }
            }, 5000);
          }
        };
      })(this));
      if (!this.view_full && !this.delay_load) {
        this.timeout_id = setTimeout((function(_this) {
          return function() {
            if (!_this.received_iframe_message) {
              return _this.show_error();
            }
          };
        })(this), 10000);
      }
      if (!this.view_full) {
        this.$delayed_load_controls.click((function(_this) {
          return function(e) {
            var $full_iframe, iframe_src_to_use, post_id;
            quanto.track_mixpanel("Async notebook preview loaded");
            _this.delay_load_triggered = true;
            _this.$delayed_load_controls.addClass("hidden");
            _this.$loading_area.removeClass("hidden");
            _this.$iframe_wrapper.removeClass("hidden");
            iframe_src_to_use = _this.$iframe_elem.attr("src_to_use");
            _this.$iframe_elem.attr('src', iframe_src_to_use);
            post_id = $(e.target).closest(".delay-load-controls").data("post_id");
            $full_iframe = $("#full-iframe-" + post_id);
            $full_iframe.attr('src', $full_iframe.attr("src_to_use"));
            $("#clone-notebook-post-" + post_id).removeClass("disabled");
            return $("#full-notebook-button-" + post_id).removeClass("disabled");
          };
        })(this));
      }
    }

    NotebookIframeManager.prototype.show_error = function() {
      this.$loading_area.addClass("hidden");
      this.$error_area.removeClass("hidden");
      return this.$full_notebook_button.addClass('disabled');
    };

    NotebookIframeManager.prototype.send_post_message = function(data) {
      if (this.nb_preview_url) {
        return this.iframe_window.postMessage(data, this.nb_preview_url);
      }
    };

    NotebookIframeManager.prototype.show_full_notebook_on_the_forums = function(event) {
      var $cur_widget, $empty_backdrop, $full_nb_modal, $iframe_elem;
      $iframe_elem = this.$iframe_elem;
      $cur_widget = $iframe_elem.closest(".nb-preview-widget");
      $full_nb_modal = $cur_widget.find('.full-notebook-modal');
      $full_nb_modal.modal("show");
      this.$full_notebook_manager.fit_to_contents();
      $empty_backdrop = $full_nb_modal.find('.empty-backdrop');
      $empty_backdrop.click((function(_this) {
        return function(e) {
          return $full_nb_modal.modal('hide');
        };
      })(this));
      return $full_nb_modal.on('shown.bs.modal', (function(_this) {
        return function(e) {
          var scroll_bar_width;
          _this.$full_notebook_manager.fit_to_contents();
          scroll_bar_width = $full_nb_modal.outerWidth(true) - $empty_backdrop.outerWidth(true);
          $full_nb_modal.find('.nb-reader-navbar').css('right', scroll_bar_width);
          return $full_nb_modal.find('.close-link').css('right', -scroll_bar_width);
        };
      })(this));
    };

    NotebookIframeManager.prototype.receive_post_message = function(event) {
      var height;
      if (event.origin === this.nb_preview_url && event.source === this.iframe_window && (event.data != null)) {
        if (event.data.event === 'height_changed') {
          if (!this.view_full) {
            this.$loading_area.addClass("hidden");
            this.$iframe_elem.addClass('animate-height');
            setTimeout((function(_this) {
              return function() {
                _this.$iframe_wrapper.removeClass("hidden");
                return _this.$full_notebook_button.removeClass('disabled');
              };
            })(this), 500);
          }
          this.received_iframe_message = true;
          height = event.data.height;
          if ((height != null) && height !== 0) {
            this.$iframe_elem.height(height);
          }
        }
        if (event.data.event === 'notebook_clicked') {
          if (!this.view_full) {
            return this.show_full_notebook_on_the_forums(event);
          }
        }
      }
    };

    NotebookIframeManager.prototype.fit_to_contents = function() {
      return this.send_post_message({
        event: 'get_height'
      });
    };

    return NotebookIframeManager;

  })();

}).call(this);
(function() {
  var ContentManager,
    bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

  quanto.ContentManager = ContentManager = (function() {
    function ContentManager() {
      this.send_to_mixpanel = bind(this.send_to_mixpanel, this);
      this.update_content_card_height = bind(this.update_content_card_height, this);
      var MOBILE_WIDTH, can_resize;
      MOBILE_WIDTH = 768;
      this.$show_more_button = $('.show-more');
      quanto.on_click(this.$show_more_button, (function(_this) {
        return function(e) {
          $('.suggested-content .content-wrapper').slice(3).removeClass('hidden');
          if ($('.suggested-content .content-wrapper .hidden').length === 0) {
            return _this.$show_more_button.addClass('hidden');
          }
        };
      })(this));
      quanto.on_click('.content-mixpanel-button', (function(_this) {
        return function(e) {
          var $clicked_elem, referrer, target;
          $clicked_elem = $(quanto.get_src_element(e));
          target = $clicked_elem.closest('.content-wrapper').data("mixpanel-target");
          referrer = window.location.pathname;
          return _this.send_to_mixpanel(referrer, target);
        };
      })(this));
      if ($(window).width() >= MOBILE_WIDTH) {
        this.update_content_card_height();
      } else {
        can_resize = true;
        $(window).resize((function(_this) {
          return function() {
            if (can_resize && $(window).width() >= MOBILE_WIDTH) {
              _this.update_content_card_height();
              return can_resize = false;
            }
          };
        })(this));
      }
    }

    ContentManager.prototype.update_content_card_height = function() {
      var max_height;
      max_height = Math.max.apply(null, $(".suggested-content .content-wrapper").map(function() {
        return $(this).height();
      }).get());
      return $(".suggested-content .content-wrapper").each(function() {
        return $(this).height(max_height);
      });
    };

    ContentManager.prototype.send_to_mixpanel = function(referrer, target) {
      return mixpanel.track('related content click', {
        "referrer": referrer,
        "target": target
      });
    };

    return ContentManager;

  })();

}).call(this);
(function(){var k,bW=document,bf=window,a8=Math,o=a8.round,bE=a8.floor,aK=a8.ceil,cu=a8.max,aw=a8.min,f=a8.abs,cm=a8.cos,ag=a8.sin,S=a8.PI,aI=S*2/360,u=navigator.userAgent,aE=bf.opera,q=/msie/i.test(u)&&!aE,E=bW.documentMode===8,N=/AppleWebKit/.test(u),bG=/Firefox/.test(u),ba=/(Mobile|Android|Windows Phone)/.test(u),bd="http://www.w3.org/2000/svg",cl=!!bW.createElementNS&&!!bW.createElementNS(bd,"svg").createSVGRect,ak=bG&&parseInt(u.split("Firefox/")[1],10)<4,bj=!cl&&!q&&!!bW.createElement("canvas").getContext,cf,H,c={},bo=0,ao,bS,cb,cv,az,bg,j=function(){},aO=[],bX="Highstock",cj="1.3.10",P="div",ax="absolute",O="relative",ap="hidden",bk="highcharts-",av="visible",ab="px",B="none",bN="M",bO="L",am=/^[0-9]+$/,au="",a2="hover",bJ="select",ck="millisecond",by="second",b3="minute",Z="hour",b5="day",ch="week",bx="month",bu="year",r,aT="stroke-width",af,bz,D,aa,aF,bC,ae,ac,ay,b2,aM,b7,J,a={};var aZ=bf.Highcharts=bf.Highcharts?b9(16,true):{};function bD(M,L){var cw;if(!M){M={}}for(cw in L){M[cw]=L[cw]}return M}function aY(){var cy,cx=arguments,L,cw={},M=function(cC,cA){var cB,cz;if(typeof cC!=="object"){cC={}}for(cz in cA){if(cA.hasOwnProperty(cz)){cB=cA[cz];if(cB&&typeof cB==="object"&&Object.prototype.toString.call(cB)!=="[object Array]"&&cz!=="renderTo"&&typeof cB.nodeType!=="number"){cC[cz]=M(cC[cz]||{},cB)}else{cC[cz]=cA[cz]}}}return cC};if(cx[0]===true){cw=cx[1];cx=Array.prototype.slice.call(cx,2)}L=cx.length;for(cy=0;cy<L;cy++){cw=M(cw,cx[cy])}return cw}function a7(){var M=0,L=arguments,cw=L.length,cx={};for(;M<cw;M++){cx[L[M++]]=L[M]}return cx}function b8(L,M){return parseInt(L,M||10)}function bK(L){return typeof L==="string"}function cr(L){return typeof L==="object"}function aP(L){return Object.prototype.toString.call(L)==="[object Array]"}function aD(L){return typeof L==="number"}function v(L){return a8.log(L)/a8.LN10}function y(L){return a8.pow(10,L)}function T(L,cw){var M=L.length;while(M--){if(L[M]===cw){L.splice(M,1);break}}}function an(L){return L!==k&&L!==null}function V(cw,cz,cy){var M,cx="setAttribute",L;if(bK(cz)){if(an(cy)){cw[cx](cz,cy)}else{if(cw&&cw.getAttribute){L=cw.getAttribute(cz)}}}else{if(an(cz)&&cr(cz)){for(M in cz){cw[cx](M,cz[M])}}}return L}function bw(L){return aP(L)?L:[L]}function a0(){var M=arguments,cw,L,cx=M.length;for(cw=0;cw<cx;cw++){L=M[cw];if(typeof L!=="undefined"&&L!==null){return L}}}function cp(L,M){if(q&&!cl){if(M&&M.opacity!==k){M.filter="alpha(opacity="+(M.opacity*100)+")"}}bD(L.style,M)}function bF(L,cz,cy,cx,cw){var M=bW.createElement(L);if(cz){bD(M,cz)}if(cw){cp(M,{padding:0,border:B,margin:0})}if(cy){cp(M,cy)}if(cx){cx.appendChild(M)}return M}function bA(cw,L){var M=function(){};M.prototype=new cw();bD(M.prototype,L);return M}function m(cy,cx,cE,cD,cH){var M=bS.lang,cw=+cy||0,cC=cx===-1?(cw.toString().split(".")[1]||"").length:(isNaN(cx=f(cx))?2:cx),cB=cE===undefined?M.decimalPoint:cE,cF=cD===undefined?M.thousandsSep:cD,cG=cw<0?"-":"",cA=String(b8(cw=f(cw).toFixed(cC))),cz=cA.length>3?cA.length%3:0;var L=cH?"$":"";return cG+L+(cz?cA.substr(0,cz)+cF:"")+cA.substr(cz).replace(/(\d{3})(?=\d)/g,"$1"+cF)+(cC?cB+f(cw-cA).toFixed(cC).slice(2):"")}function b0(M,L){return new Array((L||2)+1-String(M).length).join(0)+M}function bc(cw,cx,M){var L=cw[cx];cw[cx]=function(){var cy=Array.prototype.slice.call(arguments);cy.unshift(L);return M.apply(this,cy)}}function ai(cy,cx){if(!cy){return 0}var L=0,cw=cy.length;while(L<cw){var M=(L+cw)>>1;cy[M]<cx?L=M+1:cw=M}return L}cb=function(cD,cz,cx){if(!an(cz)||isNaN(cz)){return"Invalid date"}cD=a0(cD,"%Y-%m-%d %H:%M:%S");var M=new Date(cz-bz),cF,cC=M[aa](),cA=M[aF](),cE=M[bC](),cy=M[ae](),cG=M[ac](),L=bS.lang,cB=L.weekdays,cw=bD({a:cB[cA].substr(0,3),A:cB[cA],d:b0(cE),e:cE,b:L.shortMonths[cy],B:L.months[cy],m:b0(cy+1),y:cG.toString().substr(2,2),Y:cG,H:b0(cC),I:b0((cC%12)||12),l:(cC%12)||12,M:b0(M[D]()),p:cC<12?"AM":"PM",P:cC<12?"am":"pm",S:b0(M.getSeconds()),L:b0(o(cz%1000),3)},aZ.dateFormats);for(cF in cw){while(cD.indexOf("%"+cF)!==-1){cD=cD.replace("%"+cF,typeof cw[cF]==="function"?cw[cF](cz):cw[cF])}}return cx?cD.substr(0,1).toUpperCase()+cD.substr(1):cD};function bt(cw,cz){var M=/f$/,cy=/\.([0-9])/,cx=bS.lang,L;if(M.test(cw)){L=cw.match(cy);L=L?L[1]:-1;cz=m(cz,L,cx.decimalPoint,cw.indexOf(",")>-1?cx.thousandsSep:"")}else{cz=cb(cw,cz)}return cz}function g(cC,cE){var L="{",cD=false,cy,M,cF,cx,cA,cB=[],cw,cz;while((cz=cC.indexOf(L))!==-1){cy=cC.slice(0,cz);if(cD){M=cy.split(":");cF=M.shift().split(".");cA=cF.length;cw=cE;for(cx=0;cx<cA;cx++){cw=cw[cF[cx]]}if(M.length){cw=bt(M.join(":"),cw)}cB.push(cw)}else{cB.push(cy)}cC=cC.slice(cz+1);cD=!cD;L=cD?"}":"{"}cB.push(cC);return cB.join("")}function n(L){return a8.pow(10,bE(a8.log(L)/a8.LN10))}function b1(L,cz,cx,M){var cy,cw;cx=a0(cx,1);cy=L/cx;if(!cz){cz=[1,2,2.5,5,10];if(M&&M.allowDecimals===false){if(cx===1){cz=[1,2,5,10]}else{if(cx<=0.1){cz=[1/cx]}}}}for(cw=0;cw<cz.length;cw++){L=cz[cw];if(cy<=(cz[cw]+(cz[cw+1]||cz[cw]))/2){break}}L*=cx;return L}function R(){this.color=0;this.symbol=0}R.prototype={wrapColor:function(L){if(this.color>=L){this.color=0}},wrapSymbol:function(L){if(this.symbol>=L){this.symbol=0}}};function aQ(M,L){var cy=M.length,cw,cx;for(cx=0;cx<cy;cx++){M[cx].ss_i=cx}M.sort(function(cA,cz){cw=L(cA,cz);return cw===0?cA.ss_i-cz.ss_i:cw});for(cx=0;cx<cy;cx++){delete M[cx].ss_i}}function bY(cw){var M=cw.length,L=cw[0];while(M--){if(cw[M]<L){L=cw[M]}}return L}function aS(cw){var M=cw.length,L=cw[0];while(M--){if(cw[M]>L){L=cw[M]}}return L}function bp(M,L){var cw;for(cw in M){if(M[cw]&&M[cw]!==L&&M[cw].destroy){M[cw].destroy()}delete M[cw]}}function ca(L){if(!ao){ao=bF(P)}if(L){ao.appendChild(L)}ao.innerHTML=""}function b9(M,L){var cw="Highcharts error #"+M+": www.highcharts.com/errors/"+M;if(L){throw cw}else{if(bf.console){console.log(cw)}}}function al(L){return parseFloat(L.toPrecision(14))}function cq(M,L){cv=a0(M,L.animation)}bg=a7(ck,1,by,1000,b3,60000,Z,3600000,b5,24*3600000,ch,7*24*3600000,bx,31*24*3600000,bu,31556952000);az={init:function(cy,cD,cE){cD=cD||"";var M=cy.shift,cw=cD.indexOf("C")>-1,cx=cw?7:3,cB,cF,cA,L=cD.split(" "),cz=[].concat(cE),cH,cC,cG=function(cI){cA=cI.length;while(cA--){if(cI[cA]===bN){cI.splice(cA+1,0,cI[cA+1],cI[cA+2],cI[cA+1],cI[cA+2])}}};if(cw){cG(L);cG(cz)}if(cy.isArea){cH=L.splice(L.length-6,6);cC=cz.splice(cz.length-6,6)}if(M<=cz.length/cx&&L.length===cz.length){while(M--){cz=[].concat(cz).splice(0,cx).concat(cz)}}cy.shift=0;if(L.length){cB=cz.length;while(L.length<cB){cF=[].concat(L).splice(L.length-cx,cx);if(cw){cF[cx-6]=cF[cx-2];cF[cx-5]=cF[cx-1]}L=L.concat(cF)}}if(cH){L=L.concat(cH);cz=cz.concat(cC)}return[L,cz]},step:function(cA,M,cz,L){var cx=[],cy=cA.length,cw;if(cz===1){cx=L}else{if(cy===M.length&&cz<1){while(cy--){cw=parseFloat(cA[cy]);cx[cy]=isNaN(cw)?cA[cy]:cz*(parseFloat(M[cy]-cw))+cw}}else{cx=M}}return cx}};(function(L){bf.HighchartsAdapter=bf.HighchartsAdapter||(L&&{init:function(cA){var cz=L.fx,cw=cz.step,cy,cB=L.Tween,M=cB&&cB.propHooks,cx=L.cssHooks.opacity;L.extend(L.easing,{easeOutQuad:function(cD,cE,cC,cG,cF){return -cG*(cE/=cF)*(cE-2)+cC}});L.each(["cur","_default","width","height","opacity"],function(cC,cD){var cF=cw,cE;if(cD==="cur"){cF=cz.prototype}else{if(cD==="_default"&&cB){cF=M[cD];cD="set"}}cE=cF[cD];if(cE){cF[cD]=function(cH){var cG;cH=cC?cH:this;if(cH.prop==="align"){return}cG=cH.elem;return cG.attr?cG.attr(cH.prop,cD==="cur"?k:cH.now):cE.apply(this,arguments)}}});bc(cx,"get",function(cE,cD,cC){return cD.attr?(cD.opacity||0):cE.call(this,cD,cC)});cy=function(cE){var cD=cE.elem,cC;if(!cE.started){cC=cA.init(cD,cD.d,cD.toD);cE.start=cC[0];cE.end=cC[1];cE.started=true}cD.attr("d",cA.step(cE.start,cE.end,cE.pos,cD.toD))};if(cB){M.d={set:cy}}else{cw.d=cy}this.each=Array.prototype.forEach?function(cC,cD){return Array.prototype.forEach.call(cC,cD)}:function(cD,cF){var cE=0,cC=cD.length;for(;cE<cC;cE++){if(cF.call(cD[cE],cD[cE],cE,cD)===false){return cE}}};L.fn.highcharts=function(){var cG="Chart",cE=arguments,cD,cC,cF;if(bK(cE[0])){cG=cE[0];cE=Array.prototype.slice.call(cE,1)}cD=cE[0];if(cD!==k){cD.chart=cD.chart||{};cD.chart.renderTo=this[0];cF=new aZ[cG](cD,cE[1]);cC=this}if(cD===k){cC=aO[V(this[0],"data-highcharts-chart")]}return cC}},getScript:L.getScript,inArray:L.inArray,adapterRun:function(M,cw){return L(M)[cw]()},grep:L.grep,map:function(cw,cz){var cy=[],cx=0,M=cw.length;for(;cx<M;cx++){cy[cx]=cz.call(cw[cx],cw[cx],cx,cw)}return cy},offset:function(M){return L(M).offset()},addEvent:function(cw,cx,M){L(cw).bind(cx,M)},removeEvent:function(cx,M,cw){var cy=bW.removeEventListener?"removeEventListener":"detachEvent";if(bW[cy]&&cx&&!cx[cy]){cx[cy]=function(){}}L(cx).unbind(M,cw)},fireEvent:function(cz,cy,cw,M){var cB=L.Event(cy),cA="detached"+cy,cx;if(!q&&cw){delete cw.layerX;delete cw.layerY}bD(cB,cw);if(cz[cy]){cz[cA]=cz[cy];cz[cy]=null}L.each(["preventDefault","stopPropagation"],function(cC,cD){var cE=cB[cD];cB[cD]=function(){try{cE.call(cB)}catch(cF){if(cD==="preventDefault"){cx=true}}}});L(cz).trigger(cB);if(cz[cA]){cz[cy]=cz[cA];cz[cA]=null}if(M&&!cB.isDefaultPrevented()&&!cx){M(cB)}},washMouseEvent:function(cw){var M=cw.originalEvent||cw;if(M.pageX===k){M.pageX=cw.pageX;M.pageY=cw.pageY}return M},animate:function(cx,cy,M){var cw=L(cx);if(!cx.style){cx.style={}}if(cy.d){cx.toD=cy.d;cy.d=1}cw.stop();if(cy.opacity!==k&&cx.attr){cy.opacity+="px"}cw.animate(cy,M)},stop:function(M){L(M).stop()}})}(bf.jQuery));var ah=bf.HighchartsAdapter,cn=ah||{};if(ah){ah.init.call(ah,az)}var aR=cn.adapterRun,br=cn.getScript,A=cn.inArray,I=cn.each,bQ=cn.grep,cd=cn.offset,ar=cn.map,z=cn.addEvent,bh=cn.removeEvent,bM=cn.fireEvent,U=cn.washMouseEvent,t=cn.animate,bb=cn.stop;var w={enabled:true,x:0,y:15,style:{color:"#666",cursor:"default",fontSize:"11px"}};bS={colors:["#2f7ed8","#0d233a","#8bbc21","#910000","#1aadce","#492970","#f28f43","#77a1e5","#c42525","#a6c96a"],symbols:["circle","diamond","square","triangle","triangle-down"],lang:{loading:"Loading...",months:["January","February","March","April","May","June","July","August","September","October","November","December"],shortMonths:["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],weekdays:["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],decimalPoint:".",numericSymbols:["k","M","B","T","P","E"],resetZoom:"Reset zoom",resetZoomTitle:"Reset zoom level 1:1",thousandsSep:","},global:{useUTC:true,canvasToolsURL:"http://code.highcharts.com/stock/1.3.10/modules/canvas-tools.js",VMLRadialGradientURL:"http://code.highcharts.com/stock/1.3.10/gfx/vml-radial-gradient.png"},chart:{borderColor:"#4572A7",borderRadius:5,defaultSeriesType:"line",ignoreHiddenSeries:true,spacing:[10,10,15,10],backgroundColor:"#FFFFFF",plotBorderColor:"#C0C0C0",resetZoomButton:{theme:{zIndex:20},position:{align:"right",x:-10,y:10}}},title:{text:"Chart title",align:"center",margin:15,style:{color:"#274b6d",fontSize:"16px"}},subtitle:{text:"",align:"center",style:{color:"#4d759e"}},plotOptions:{line:{allowPointSelect:false,showCheckbox:false,animation:{duration:1000},events:{},lineWidth:2,marker:{enabled:true,lineWidth:0,radius:4,lineColor:"#FFFFFF",states:{hover:{enabled:true},select:{fillColor:"#FFFFFF",lineColor:"#000000",lineWidth:2}}},point:{events:{}},dataLabels:aY(w,{align:"center",enabled:false,formatter:function(){return this.y===null?"":m(this.y,-1)},verticalAlign:"bottom",y:0}),cropThreshold:300,pointRange:0,states:{hover:{marker:{}},select:{marker:{}}},stickyTracking:true,turboThreshold:1000}},labels:{style:{position:ax,color:"#3E576F"}},legend:{enabled:true,align:"center",layout:"horizontal",labelFormatter:function(){return this.name},borderWidth:1,borderColor:"#909090",borderRadius:5,navigation:{activeColor:"#274b6d",inactiveColor:"#CCC"},shadow:false,itemStyle:{color:"#274b6d",fontSize:"12px"},itemHoverStyle:{color:"#000"},itemHiddenStyle:{color:"#CCC"},itemCheckboxStyle:{position:ax,width:"13px",height:"13px"},symbolPadding:5,verticalAlign:"bottom",x:0,y:0,title:{style:{fontWeight:"bold"}}},loading:{labelStyle:{fontWeight:"bold",position:O,top:"1em"},style:{position:ax,backgroundColor:"white",opacity:0.5,textAlign:"center"}},tooltip:{enabled:true,animation:cl,backgroundColor:"rgba(255, 255, 255, .85)",borderWidth:1,borderRadius:3,dateTimeLabelFormats:{millisecond:"%A, %b %e, %H:%M:%S.%L",second:"%A, %b %e, %H:%M:%S",minute:"%A, %b %e, %H:%M",hour:"%A, %b %e, %H:%M",day:"%A, %b %e, %Y",week:"Week from %A, %b %e, %Y",month:"%B %Y",year:"%Y"},headerFormat:'<span style="font-size: 10px">{point.key}</span><br/>',pointFormat:'<span style="color:{series.color}">{series.name}</span>: <b>{point.y}</b><br/>',shadow:true,snap:ba?25:10,style:{color:"#333333",cursor:"default",fontSize:"12px",padding:"8px",whiteSpace:"nowrap"}},credits:{enabled:true,text:"Highcharts.com",href:"http://www.highcharts.com",position:{align:"right",x:-10,verticalAlign:"bottom",y:-5},style:{cursor:"pointer",color:"#909090",fontSize:"9px"}}};var at=bS.plotOptions,a6=at.line;W();function W(){var cw=bS.global.useUTC,L=cw?"getUTC":"get",M=cw?"setUTC":"set";bz=((cw&&bS.global.timezoneOffset)||0)*60000;af=cw?Date.UTC:function(cA,cB,cy,cx,cz,cC){return new Date(cA,cB,a0(cy,1),a0(cx,0),a0(cz,0),a0(cC,0)).getTime()};D=L+"Minutes";aa=L+"Hours";aF=L+"Day";bC=L+"Date";ae=L+"Month";ac=L+"FullYear";ay=M+"Minutes";b2=M+"Hours";aM=M+"Date";b7=M+"Month";J=M+"FullYear"}function bl(L){bS=aY(true,bS,L);W();return bS}function aN(){return bS}var aj=/rgba\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]?(?:\.[0-9]+)?)\s*\)/,aA=/#([a-fA-F0-9]{2})([a-fA-F0-9]{2})([a-fA-F0-9]{2})/,bn=/rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)/;var b6=function(M){var cy=[],L,cA;function cB(cC){if(cC&&cC.stops){cA=ar(cC.stops,function(cD){return b6(cD[1])})}else{L=aj.exec(cC);if(L){cy=[b8(L[1]),b8(L[2]),b8(L[3]),parseFloat(L[4],10)]}else{L=aA.exec(cC);if(L){cy=[b8(L[1],16),b8(L[2],16),b8(L[3],16),1]}else{L=bn.exec(cC);if(L){cy=[b8(L[1]),b8(L[2]),b8(L[3]),1]}}}}}function cx(cD){var cC;if(cA){cC=aY(M);cC.stops=[].concat(cC.stops);I(cA,function(cF,cE){cC.stops[cE]=[cC.stops[cE][0],cF.get(cD)]})}else{if(cy&&!isNaN(cy[0])){if(cD==="rgb"){cC="rgb("+cy[0]+","+cy[1]+","+cy[2]+")"}else{if(cD==="a"){cC=cy[3]}else{cC="rgba("+cy.join(",")+")"}}}else{cC=M}}return cC}function cz(cD){if(cA){I(cA,function(cE){cE.brighten(cD)})}else{if(aD(cD)&&cD!==0){var cC;for(cC=0;cC<3;cC++){cy[cC]+=b8(cD*255);if(cy[cC]<0){cy[cC]=0}if(cy[cC]>255){cy[cC]=255}}}}return this}function cw(cC){cy[3]=cC;return this}cB(M);return{get:cx,brighten:cz,rgba:cy,setOpacity:cw}};function aH(){}aH.prototype={init:function(L,cw){var M=this;M.element=cw==="span"?bF(cw):bW.createElementNS(bd,cw);M.renderer=L;M.attrSetters={}},opacity:1,animate:function(cx,M,L){var cw=a0(M,cv,true);bb(this);if(cw){cw=aY(cw,{});if(L){cw.complete=L}t(this,cx,cw)}else{this.attr(cx);if(L){L()}}},attr:function(cw,cL){var cy=this,cJ,cE,cD,cH,cB,cx=cy.element,L=cx.nodeName.toLowerCase(),cF=cy.renderer,cC,cG,cK=cy.attrSetters,M=cy.shadows,cA,cz,cI=cy;if(bK(cw)&&an(cL)){cJ=cw;cw={};cw[cJ]=cL}if(bK(cw)){cJ=cw;if(L==="circle"){cJ={x:"cx",y:"cy"}[cJ]||cJ}else{if(cJ==="strokeWidth"){cJ="stroke-width"}}cI=V(cx,cJ)||cy[cJ]||0;if(cJ!=="d"&&cJ!=="visibility"&&cJ!=="fill"){cI=parseFloat(cI)}}else{for(cJ in cw){cC=false;cE=cw[cJ];cD=cK[cJ]&&cK[cJ].call(cy,cE,cJ);if(cD!==false){if(cD!==k){cE=cD}if(cJ==="d"){if(cE&&cE.join){cE=cE.join(" ")}if(/(NaN| {2}|^$)/.test(cE)){cE="M 0 0"}}else{if(cJ==="x"&&L==="text"){for(cH=0;cH<cx.childNodes.length;cH++){cB=cx.childNodes[cH];if(V(cB,"x")===V(cx,"x")){V(cB,"x",cE)}}}else{if(cy.rotation&&(cJ==="x"||cJ==="y")){cz=true}else{if(cJ==="fill"){cE=cF.color(cE,cx,cJ)}else{if(L==="circle"&&(cJ==="x"||cJ==="y")){cJ={x:"cx",y:"cy"}[cJ]||cJ}else{if(L==="rect"&&cJ==="r"){V(cx,{rx:cE,ry:cE});cC=true}else{if(cJ==="translateX"||cJ==="translateY"||cJ==="rotation"||cJ==="verticalAlign"||cJ==="scaleX"||cJ==="scaleY"){cz=true;cC=true}else{if(cJ==="stroke"){cE=cF.color(cE,cx,cJ)}else{if(cJ==="dashstyle"){cJ="stroke-dasharray";cE=cE&&cE.toLowerCase();if(cE==="solid"){cE=B}else{if(cE){cE=cE.replace("shortdashdotdot","3,1,1,1,1,1,").replace("shortdashdot","3,1,1,1").replace("shortdot","1,1,").replace("shortdash","3,1,").replace("longdash","8,3,").replace(/dot/g,"1,3,").replace("dash","4,3,").replace(/,$/,"").split(",");cH=cE.length;while(cH--){cE[cH]=b8(cE[cH])*a0(cw["stroke-width"],cy["stroke-width"])}cE=cE.join(",")}}}else{if(cJ==="width"){cE=b8(cE)}else{if(cJ==="align"){cJ="text-anchor";cE={left:"start",center:"middle",right:"end"}[cE]}else{if(cJ==="title"){cG=cx.getElementsByTagName("title")[0];if(!cG){cG=bW.createElementNS(bd,"title");cx.appendChild(cG)}cG.textContent=cE}}}}}}}}}}}}if(cJ==="strokeWidth"){cJ="stroke-width"}if(cJ==="stroke-width"||cJ==="stroke"){cy[cJ]=cE;if(cy.stroke&&cy["stroke-width"]){V(cx,"stroke",cy.stroke);V(cx,"stroke-width",cy["stroke-width"]);cy.hasStroke=true}else{if(cJ==="stroke-width"&&cE===0&&cy.hasStroke){cx.removeAttribute("stroke");cy.hasStroke=false}}cC=true}if(cy.symbolName&&/^(x|y|width|height|r|start|end|innerR|anchorX|anchorY)/.test(cJ)){if(!cA){cy.symbolAttr(cw);cA=true}cC=true}if(M&&/^(width|height|visibility|x|y|d|transform|cx|cy|r)$/.test(cJ)){cH=M.length;while(cH--){V(M[cH],cJ,cJ==="height"?cu(cE-(M[cH].cutHeight||0),0):cE)}}if((cJ==="width"||cJ==="height")&&L==="rect"&&cE<0){cE=0}cy[cJ]=cE;if(cJ==="text"){if(cE!==cy.textStr){delete cy.bBox;cy.textStr=cE;if(cy.added){cF.buildText(cy)}}}else{if(!cC){if(cE!==undefined){cx.setAttribute(cJ,cE)}}}}}if(cz){cy.updateTransform()}}return cI},addClass:function(M){var L=this.element,cw=V(L,"class")||"";if(cw.indexOf(M)===-1){V(L,"class",cw+" "+M)}return this},symbolAttr:function(L){var M=this;I(["x","y","r","start","end","width","height","innerR","anchorX","anchorY"],function(cw){M[cw]=a0(L[cw],M[cw])});M.attr({d:M.renderer.symbols[M.symbolName](M.x,M.y,M.width,M.height,M)})},clip:function(L){return this.attr("clip-path",L?"url("+this.renderer.url+"#"+L.id+")":B)},crisp:function(cw){var cz=this,L,cx={},M,cy=cw.strokeWidth||cz.strokeWidth||(cz.attr&&cz.attr("stroke-width"))||0;M=o(cy)%2/2;cw.x=bE(cw.x||cz.x||0)+M;cw.y=bE(cw.y||cz.y||0)+M;cw.width=bE((cw.width||cz.width||0)-2*M);cw.height=bE((cw.height||cz.height||0)-2*M);cw.strokeWidth=cy;for(L in cw){if(cz[L]!==cw[L]){cz[L]=cx[L]=cw[L]}}return cx},css:function(cC){var cB=this,cD=cB.styles,L={},cx=cB.element,cz,cw,cy="",cA,M=!cD;if(cC&&cC.color){cC.fill=cC.color}if(cD){for(cw in cC){if(cC[cw]!==cD[cw]){L[cw]=cC[cw];M=true}}}if(M){cz=cB.textWidth=cC&&cC.width&&cx.nodeName.toLowerCase()==="text"&&b8(cC.width);if(cD){cC=bD(cD,L)}cB.styles=cC;if(cz&&(bj||(!cl&&cB.renderer.forExport))){delete cC.width}if(q&&!cl){cp(cB.element,cC)}else{cA=function(cF,cE){return"-"+cE.toLowerCase()};for(cw in cC){cy+=cw.replace(/([A-Z])/g,cA)+":"+cC[cw]+";"}V(cx,"style",cy)}if(cz&&cB.added){cB.renderer.buildText(cB)}}return cB},on:function(M,cw){var cx=this,L=cx.element;if(H&&M==="click"){L.ontouchstart=function(cy){cx.touchEventFired=Date.now();cy.preventDefault();cw.call(L,cy)};L.onclick=function(cy){if(u.indexOf("Android")===-1||Date.now()-(cx.touchEventFired||0)>1100){cw.call(L,cy)}}}else{L["on"+M]=cw}return this},setRadialReference:function(L){this.element.radialReference=L;return this},translate:function(L,M){return this.attr({translateX:L,translateY:M})},invert:function(){var L=this;L.inverted=true;L.updateTransform();return L},updateTransform:function(){var cB=this,cA=cB.translateX||0,cz=cB.translateY||0,cx=cB.scaleX,M=cB.scaleY,L=cB.inverted,cy=cB.rotation,cw;if(L){cA+=cB.attr("width");cz+=cB.attr("height")}cw=["translate("+cA+","+cz+")"];if(L){cw.push("rotate(90) scale(-1,1)")}else{if(cy){cw.push("rotate("+cy+" "+(cB.x||0)+" "+(cB.y||0)+")")}}if(an(cx)||an(M)){cw.push("scale("+a0(cx,1)+" "+a0(M,1)+")")}if(cw.length){V(cB.element,"transform",cw.join(" "))}},toFront:function(){var L=this.element;L.parentNode.appendChild(L);return this},align:function(M,cC,cx){var cA,cy,cE,cD,L={},cz,cB=this.renderer,cw=cB.alignedObjects;if(M){this.alignOptions=M;this.alignByTranslate=cC;if(!cx||bK(cx)){this.alignTo=cz=cx||"renderer";T(cw,this);cw.push(this);cx=null}}else{M=this.alignOptions;cC=this.alignByTranslate;cz=this.alignTo}cx=a0(cx,cB[cz],cB);cA=M.align;cy=M.verticalAlign;cE=(cx.x||0)+(M.x||0);cD=(cx.y||0)+(M.y||0);if(cA==="right"||cA==="center"){cE+=(cx.width-(M.width||0))/{right:1,center:2}[cA]}L[cC?"translateX":"x"]=o(cE);if(cy==="bottom"||cy==="middle"){cD+=(cx.height-(M.height||0))/({bottom:1,middle:2}[cy]||1)}L[cC?"translateY":"y"]=o(cD);this[this.placed?"animate":"attr"](L);this.placed=true;this.alignAttr=L;return this},getBBox:function(){var M=this,cD=M.bBox,cz=M.renderer,cw,cB,cE=M.rotation,cx=M.element,cC=M.styles,cA=cE*aI,cF=M.textStr,L;if(cF===""||am.test(cF)){L=cF.toString().length+(cC?("|"+cC.fontSize+"|"+cC.fontFamily):"");cD=cz.cache[L]}if(!cD){if(cx.namespaceURI===bd||cz.forExport){try{cD=cx.getBBox?bD({},cx.getBBox()):{width:cx.offsetWidth,height:cx.offsetHeight}}catch(cy){}if(!cD||cD.width<0){cD={width:0,height:0}}}else{cD=M.htmlGetBBox()}if(cz.isSVG){cw=cD.width;cB=cD.height;if(q&&cC&&cC.fontSize==="11px"&&cB.toPrecision(3)==="16.9"){cD.height=cB=14}if(cE){cD.width=f(cB*ag(cA))+f(cw*cm(cA));cD.height=f(cB*cm(cA))+f(cw*ag(cA))}}M.bBox=cD;if(L){cz.cache[L]=cD}}return cD},show:function(L){return this.attr({visibility:L?"inherit":av})},hide:function(){return this.attr({visibility:ap})},fadeOut:function(M){var L=this;L.animate({opacity:0},{duration:M||150,complete:function(){L.hide()}})},add:function(cC){var cA=this.renderer,cz=cC||cA,cy=cz.element||cA.box,cE,cx=this.element,cB=this.zIndex,cD,L,cw,M;if(cC){this.parentGroup=cC}this.parentInverted=cC&&cC.inverted;if(this.textStr!==undefined){cA.buildText(this)}if(cB){cz.handleZ=true;cB=b8(cB)}if(cz.handleZ){cE=cy.childNodes;for(cw=0;cw<cE.length;cw++){cD=cE[cw];L=V(cD,"zIndex");if(cD!==cx&&(b8(L)>cB||(!an(cB)&&an(L)))){cy.insertBefore(cx,cD);M=true;break}}}if(!M){cy.appendChild(cx)}this.added=true;if(this.onAdd){this.onAdd()}return this},safeRemoveChild:function(M){var L=M.parentNode;if(L){L.removeChild(M)}},destroy:function(){var cA=this,cw=cA.element||{},cy=cA.shadows,cx=cA.renderer.isSVG&&cw.nodeName==="SPAN"&&cA.parentGroup,cz,M,L;cw.onclick=cw.onmouseout=cw.onmouseover=cw.onmousemove=cw.point=null;bb(cA);if(cA.clipPath){cA.clipPath=cA.clipPath.destroy()}if(cA.stops){for(L=0;L<cA.stops.length;L++){cA.stops[L]=cA.stops[L].destroy()}cA.stops=null}cA.safeRemoveChild(cw);if(cy){I(cy,function(cB){cA.safeRemoveChild(cB)})}while(cx&&cx.div.childNodes.length===0){cz=cx.parentGroup;cA.safeRemoveChild(cx.div);delete cx.div;cx=cz}if(cA.alignTo){T(cA.renderer.alignedObjects,cA)}for(M in cA){delete cA[M]}return null},shadow:function(cE,cD,M){var cx=[],cy,cC,cz=this.element,cA,cw,cB,L;if(cE){cw=a0(cE.width,3);cB=(cE.opacity||0.15)/cw;L=this.parentInverted?"(-1,-1)":"("+a0(cE.offsetX,1)+", "+a0(cE.offsetY,1)+")";for(cy=1;cy<=cw;cy++){cC=cz.cloneNode(0);cA=(cw*2)+1-(2*cy);V(cC,{isShadow:"true",stroke:cE.color||"black","stroke-opacity":cB*cy,"stroke-width":cA,transform:"translate"+L,fill:B});if(M){V(cC,"height",cu(V(cC,"height")-cA,0));cC.cutHeight=cA}if(cD){cD.element.appendChild(cC)}else{cz.parentNode.insertBefore(cC,cz)}cx.push(cC)}this.shadows=cx}return this}};var d=function(){this.init.apply(this,arguments)};d.prototype={Element:aH,init:function(M,cw,cE,L,cF){var cC=this,cB=location,cz,cy,cA;cz=cC.createElement("svg").attr({version:"1.1"}).css(this.getStyle(L));cy=cz.element;M.appendChild(cy);if(M.innerHTML.indexOf("xmlns")===-1){V(cy,"xmlns",bd)}cC.isSVG=true;cC.box=cy;cC.boxWrapper=cz;cC.alignedObjects=[];cC.url=(bG||N)&&bW.getElementsByTagName("base").length?cB.href.replace(/#.*?$/,"").replace(/([\('\)])/g,"\\$1").replace(/ /g,"%20"):"";cA=this.createElement("desc").add();cA.element.appendChild(bW.createTextNode("Created with "+bX+" "+cj));cC.defs=this.createElement("defs").add();cC.forExport=cF;cC.gradients={};cC.cache={};cC.setSize(cw,cE,false);var cx,cD;if(bG&&M.getBoundingClientRect){cC.subPixelFix=cx=function(){cp(M,{left:0,top:0});cD=M.getBoundingClientRect();cp(M,{left:(aK(cD.left)-cD.left)+ab,top:(aK(cD.top)-cD.top)+ab})};cx();z(bf,"resize",cx)}},getStyle:function(L){return(this.style=bD({fontFamily:'"Lucida Grande", "Lucida Sans Unicode", Verdana, Arial, Helvetica, sans-serif',fontSize:"12px"},L))},isHidden:function(){return !this.boxWrapper.getBBox().width},destroy:function(){var L=this,M=L.defs;L.box=null;L.boxWrapper=L.boxWrapper.destroy();bp(L.gradients||{});L.gradients=null;if(M){L.defs=M.destroy()}if(L.subPixelFix){bh(bf,"resize",L.subPixelFix)}L.alignedObjects=null;return null},createElement:function(M){var L=new this.Element();L.init(this,M);return L},draw:function(){},buildText:function(L){var cx=L.element,cA=this,cG=cA.forExport,cH=a0(L.textStr,"").toString().replace(/<(b|strong)>/g,'<span style="font-weight:bold">').replace(/<(i|em)>/g,'<span style="font-style:italic">').replace(/<a/g,"<span").replace(/<\/(b|strong|i|em|a)>/g,"</span>").split(/<br.*?>/g),cD=cx.childNodes,cF=/<.*style="([^"]+)".*>/,cw=/<.*href="(http[^"]+)".*>/,cE=V(cx,"x"),cB=L.styles,M=L.textWidth,cC=cB&&cB.lineHeight,cz=cD.length,cy=function(cI){return cC?b8(cC):cA.fontMetrics(/(px|em)$/.test(cI&&cI.style.fontSize)?cI.style.fontSize:(cB.fontSize||11)).h};while(cz--){cx.removeChild(cD[cz])}if(M&&!L.added){this.box.appendChild(cx)}if(cH[cH.length-1]===""){cH.pop()}I(cH,function(cI,cL){var cK,cJ=0;cI=cI.replace(/<span/g,"|||<span").replace(/<\/span>/g,"</span>|||");cK=cI.split("|||");I(cK,function(cU){if(cU!==""||cK.length===1){var cQ={},cT=bW.createElementNS(bd,"tspan"),cV;if(cF.test(cU)){cV=cU.match(cF)[1].replace(/(;| |^)color([ :])/,"$1fill$2");V(cT,"style",cV)}if(cw.test(cU)&&!cG){V(cT,"onclick",'location.href="'+cU.match(cw)[1]+'"');cp(cT,{cursor:"pointer"})}cU=(cU.replace(/<(.|\n)*?>/g,"")||" ").replace(/&lt;/g,"<").replace(/&gt;/g,">");if(cU!==" "){cT.appendChild(bW.createTextNode(cU));if(!cJ){cQ.x=cE}else{cQ.dx=0}V(cT,cQ);if(!cJ&&cL){if(!cl&&cG){cp(cT,{display:"block"})}V(cT,"dy",cy(cT),N&&cT.offsetHeight)}cx.appendChild(cT);cJ++;if(M){var cS=cU.replace(/([^\^])-/g,"$1- ").split(" "),cR=cS.length>1&&cB.whiteSpace!=="nowrap",cW,cM,cP=L._clipHeight,cN=[],cY=cy(),cO=1,cX;while(cR&&(cS.length||cN.length)){delete L.bBox;cX=L.getBBox();cM=cX.width;if(!cl&&cA.forExport){cM=cA.measureSpanWidth(cT.firstChild.data,L.styles)}cW=cM>M;if(!cW||cS.length===1){cS=cN;cN=[];if(cS.length){cO++;if(cP&&cO*cY>cP){cS=["..."];L.attr("title",L.textStr)}else{cT=bW.createElementNS(bd,"tspan");V(cT,{dy:cY,x:cE});if(cV){V(cT,"style",cV)}cx.appendChild(cT);if(cM>M){M=cM}}}}else{cT.removeChild(cT.firstChild);cN.unshift(cS.pop())}if(cS.length){cT.appendChild(bW.createTextNode(cS.join(" ").replace(/- /g,"-")))}}}}}})})},button:function(cH,cG,cF,cx,cK,cL,cM,cJ,M){var cE=this.label(cH,cG,cF,M,null,null,null,null,"button"),cB=0,L,cI,cz,cC,cD,cy,cA="style",cw={x1:0,y1:0,x2:0,y2:1};cK=aY({"stroke-width":1,stroke:"#CCCCCC",fill:{linearGradient:cw,stops:[[0,"#FEFEFE"],[1,"#F6F6F6"]]},r:2,padding:5,style:{color:"black"}},cK);cz=cK[cA];delete cK[cA];cL=aY(cK,{stroke:"#68A",fill:{linearGradient:cw,stops:[[0,"#FFF"],[1,"#ACF"]]}},cL);cC=cL[cA];delete cL[cA];cM=aY(cK,{stroke:"#68A",fill:{linearGradient:cw,stops:[[0,"#9BD"],[1,"#CDF"]]}},cM);cD=cM[cA];delete cM[cA];cJ=aY(cK,{style:{color:"#CCC"}},cJ);cy=cJ[cA];delete cJ[cA];z(cE.element,q?"mouseover":"mouseenter",function(){if(cB!==3){cE.attr(cL).css(cC)}});z(cE.element,q?"mouseout":"mouseleave",function(){if(cB!==3){L=[cK,cL,cM][cB];cI=[cz,cC,cD][cB];cE.attr(L).css(cI)}});cE.setState=function(cN){cE.state=cB=cN;if(!cN){cE.attr(cK).css(cz)}else{if(cN===2){cE.attr(cM).css(cD)}else{if(cN===3){cE.attr(cJ).css(cy)}}}};return cE.on("click",function(){if(cB!==3){cx.call(cE)}}).attr(cK).css(bD({cursor:"default"},cz))},crispLine:function(M,L){if(M[1]===M[4]){M[1]=M[4]=o(M[1])-(L%2/2)}if(M[2]===M[5]){M[2]=M[5]=o(M[2])+(L%2/2)}return M},path:function(M){var L={fill:B};if(aP(M)){L.d=M}else{if(cr(M)){bD(L,M)}}return this.createElement("path").attr(L)},circle:function(M,cx,cw){var L=cr(M)?M:{x:M,y:cx,r:cw};return this.createElement("circle").attr(L)},arc:function(L,cA,cy,cw,cz,M){var cx;if(cr(L)){cA=L.y;cy=L.r;cw=L.innerR;cz=L.start;M=L.end;L=L.x}cx=this.symbol("arc",L||0,cA||0,cy||0,cy||0,{innerR:cw||0,start:cz||0,end:M||0});cx.r=cy;return cx},rect:function(cw,cB,cx,M,cy,cA){cy=cr(cw)?cw.r:cy;var cz=this.createElement("rect"),L=cr(cw)?cw:cw===k?{}:{x:cw,y:cB,width:cu(cx,0),height:cu(M,0)};if(cA!==k){L.strokeWidth=cA;L=cz.crisp(L)}if(cy){L.r=cy}return cz.attr(L)},setSize:function(cy,L,cw){var cz=this,M=cz.alignedObjects,cx=M.length;cz.width=cy;cz.height=L;cz.boxWrapper[a0(cw,true)?"animate":"attr"]({width:cy,height:L});while(cx--){M[cx].align()}},g:function(L){var M=this.createElement("g");return an(L)?M.attr({"class":bk+L}):M},image:function(cz,M,cA,cx,L){var cy={preserveAspectRatio:B},cw;if(arguments.length>1){bD(cy,{x:M,y:cA,width:cx,height:L})}cw=this.createElement("image").attr(cy);if(cw.element.setAttributeNS){cw.element.setAttributeNS("http://www.w3.org/1999/xlink","href",cz)}else{cw.element.setAttribute("hc-svg-href",cz)}return cw},symbol:function(cx,cE,cC,M,cF,cH){var cz,cw=this.symbols[cx],cG=cw&&cw(o(cE),o(cC),M,cF,cH),cB,cy=/^url\((.*?)\)$/,cD,cA,L;if(cG){cz=this.path(cG);bD(cz,{symbolName:cx,x:cE,y:cC,width:M,height:cF});if(cH){bD(cz,cH)}}else{if(cy.test(cx)){L=function(cI,cJ){if(cI.element){cI.attr({width:cJ[0],height:cJ[1]});if(!cI.alignByTranslate){cI.translate(o((M-cJ[0])/2),o((cF-cJ[1])/2))}}};cD=cx.match(cy)[1];cA=c[cD];cz=this.image(cD).attr({x:cE,y:cC});cz.isImg=true;if(cA){L(cz,cA)}else{cz.attr({width:0,height:0});cB=bF("img",{onload:function(){L(cz,c[cD]=[this.width,this.height])},src:cD})}}}return cz},symbols:{circle:function(L,cy,M,cx){var cw=0.166*M;return[bN,L+M/2,cy,"C",L+M+cw,cy,L+M+cw,cy+cx,L+M/2,cy+cx,"C",L-cw,cy+cx,L-cw,cy,L+M/2,cy,"Z"]},square:function(L,cx,M,cw){return[bN,L,cx,bO,L+M,cx,L+M,cx+cw,L,cx+cw,"Z"]},triangle:function(L,cx,M,cw){return[bN,L+M/2,cx,bO,L+M,cx+cw,L,cx+cw,"Z"]},"triangle-down":function(L,cx,M,cw){return[bN,L,cx,bO,L+M,cx,L+M/2,cx+cw,"Z"]},diamond:function(L,cx,M,cw){return[bN,L+M/2,cx,bO,L+M,cx+cw/2,L+M/2,cx+cw,L,cx+cw/2,"Z"]},arc:function(cF,cE,cH,cA,cI){var cw=cI.start,cC=cI.r||cH||cA,cx=cI.end-0.001,cD=cI.innerR,cz=cI.open,cB=cm(cw),L=ag(cw),M=cm(cx),cG=ag(cx),cy=cI.end-cw<S?0:1;return[bN,cF+cC*cB,cE+cC*L,"A",cC,cC,0,cy,1,cF+cC*M,cE+cC*cG,cz?bN:bO,cF+cD*M,cE+cD*cG,"A",cD,cD,0,cy,0,cF+cD*cB,cE+cD*L,cz?"":"Z"]}},clipRect:function(M,cA,cw,L){var cz,cy=bk+bo++,cx=this.createElement("clipPath").attr({id:cy}).add(this.defs);cz=this.rect(M,cA,cw,L,0).add(cx);cz.id=cy;cz.clipPath=cx;return cz},color:function(cA,cz,M){var cG=this,cI,cx=/^rgba/,cK,cC,cD,L,cJ,cF,cE,cB,cy,cw,cH=[];if(cA&&cA.linearGradient){cK="linearGradient"}else{if(cA&&cA.radialGradient){cK="radialGradient"}}if(cK){cC=cA[cK];cD=cG.gradients;cJ=cA.stops;cB=cz.radialReference;if(aP(cC)){cA[cK]=cC={x1:cC[0],y1:cC[1],x2:cC[2],y2:cC[3],gradientUnits:"userSpaceOnUse"}}if(cK==="radialGradient"&&cB&&!an(cC.gradientUnits)){cC=aY(cC,{cx:(cB[0]-cB[2]/2)+cC.cx*cB[2],cy:(cB[1]-cB[2]/2)+cC.cy*cB[2],r:cC.r*cB[2],gradientUnits:"userSpaceOnUse"})}for(cy in cC){if(cy!=="id"){cH.push(cy,cC[cy])}}for(cy in cJ){cH.push(cJ[cy])}cH=cH.join(",");if(cD[cH]){cw=cD[cH].id}else{cC.id=cw=bk+bo++;cD[cH]=L=cG.createElement(cK).attr(cC).add(cG.defs);L.stops=[];I(cJ,function(cL){var cM;if(cx.test(cL[1])){cI=b6(cL[1]);cF=cI.get("rgb");cE=cI.get("a")}else{cF=cL[1];cE=1}cM=cG.createElement("stop").attr({offset:cL[0],"stop-color":cF,"stop-opacity":cE}).add(L);L.stops.push(cM)})}return"url("+cG.url+"#"+cw+")"}else{if(cx.test(cA)){cI=b6(cA);V(cz,M+"-opacity",cI.get("a"));return cI.get("rgb")}else{cz.removeAttribute(M+"-opacity");return cA}}},text:function(cy,L,cA,cx){var cw=this,M=bj||(!cl&&cw.forExport),cz;if(cx&&!cw.forExport){return cw.html(cy,L,cA)}L=o(a0(L,0));cA=o(a0(cA,0));cz=cw.createElement("text").attr({x:L,y:cA,text:cy});if(M){cz.css({position:ax})}cz.x=L;cz.y=cA;return cz},fontMetrics:function(cw){cw=cw||this.style.fontSize;cw=/px/.test(cw)?b8(cw):/em/.test(cw)?parseFloat(cw)*12:12;var L=cw<24?cw+4:o(cw*1.2),M=o(L*0.8);return{h:L,b:M}},label:function(cP,cH,cF,L,cy,cx,cR,cM,cw){var cQ=this,cz=cQ.g(cw),cK=cQ.text("",0,0,cR).attr({zIndex:1}),cI,cC,cB=0,cL=3,cU=0,cO,cN,cW,cV,M=0,cJ={},cE,cX=cz.attrSetters,cT;function cD(){var c0,cZ,cY=cK.element.style;cC=(cO===undefined||cN===undefined||cz.styles.textAlign)&&cK.textStr&&cK.getBBox();cz.width=(cO||cC.width||0)+2*cL+cU;cz.height=(cN||cC.height||0)+2*cL;cE=cL+cQ.fontMetrics(cY&&cY.fontSize).b;if(cT){if(!cI){c0=o(-cB*cL);cZ=cM?-cE:0;cz.box=cI=L?cQ.symbol(L,c0,cZ,cz.width,cz.height,cJ):cQ.rect(c0,cZ,cz.width,cz.height,0,cJ[aT]);cI.attr("fill",B).add(cz)}if(!cI.isImg){cI.attr(aY({width:cz.width,height:cz.height},cJ))}cJ=null}}function cG(){var c0=cz.styles,cZ=c0&&c0.textAlign,cY=cU+cL*(1-cB),c1;c1=cM?0:cE;if(an(cO)&&cC&&(cZ==="center"||cZ==="right")){cY+={center:0.5,right:1}[cZ]*(cO-cC.width)}if(cY!==cK.x||c1!==cK.y){cK.attr({x:cY,y:c1})}cK.x=cY;cK.y=c1}function cS(cY,cZ){if(cI){cI.attr(cY,cZ)}else{cJ[cY]=cZ}}cz.onAdd=function(){cK.add(cz);cz.attr({text:cP,x:cH,y:cF});if(cI&&an(cy)){cz.attr({anchorX:cy,anchorY:cx})}};cX.width=function(cY){cO=cY;return false};cX.height=function(cY){cN=cY;return false};cX.padding=function(cY){if(an(cY)&&cY!==cL){cL=cY;cG()}return false};cX.paddingLeft=function(cY){if(an(cY)&&cY!==cU){cU=cY;cG()}return false};cX.align=function(cY){cB={left:0,center:0.5,right:1}[cY];return false};cX.text=function(cZ,cY){cK.attr(cY,cZ);cD();cG();return false};cX[aT]=function(cZ,cY){if(cZ){cT=true}M=cZ%2/2;cS(cY,cZ);return false};cX.stroke=cX.fill=cX.r=function(cZ,cY){if(cY==="fill"&&cZ){cT=true}cS(cY,cZ);return false};cX.anchorX=function(cZ,cY){cy=cZ;cS(cY,cZ+M-cW);return false};cX.anchorY=function(cZ,cY){cx=cZ;cS(cY,cZ-cV);return false};cX.x=function(cY){cz.x=cY;cY-=cB*((cO||cC.width)+cL);cW=o(cY);cz.attr("translateX",cW);return false};cX.y=function(cY){cV=cz.y=o(cY);cz.attr("translateY",cV);return false};var cA=cz.css;return bD(cz,{css:function(cZ){if(cZ){var cY={};cZ=aY(cZ);I(["fontSize","fontWeight","fontFamily","color","lineHeight","width","textDecoration","textShadow"],function(c0){if(cZ[c0]!==k){cY[c0]=cZ[c0];delete cZ[c0]}});cK.css(cY)}return cA.call(cz,cZ)},getBBox:function(){return{width:cC.width+2*cL,height:cC.height+2*cL,x:cC.x-cL,y:cC.y-cL}},shadow:function(cY){if(cI){cI.shadow(cY)}return cz},destroy:function(){bh(cz.element,"mouseenter");bh(cz.element,"mouseleave");if(cK){cK=cK.destroy()}if(cI){cI=cI.destroy()}aH.prototype.destroy.call(cz);cz=cQ=cD=cG=cS=null}})}};cf=d;bD(aH.prototype,{htmlCss:function(M){var cx=this,L=cx.element,cw=M&&L.tagName==="SPAN"&&M.width;if(cw){delete M.width;cx.textWidth=cw;cx.updateTransform()}cx.styles=bD(cx.styles,M);cp(cx.element,M);return cx},htmlGetBBox:function(){var cw=this,L=cw.element,M=cw.bBox;if(!M){if(L.nodeName==="text"){L.style.position=ax}M=cw.bBox={x:L.offsetLeft,y:L.offsetTop,width:L.offsetWidth,height:L.offsetHeight}}return M},htmlUpdateTransform:function(){if(!this.added){this.alignOnAdd=true;return}var L=this,cD=L.renderer,cy=L.element,cx=L.translateX||0,cw=L.translateY||0,cG=L.x||0,cF=L.y||0,cB=L.textAlign||"left",cE={left:0,center:0.5,right:1}[cB],cz=L.shadows;cp(cy,{marginLeft:cx,marginTop:cw});if(cz){I(cz,function(cJ){cp(cJ,{marginLeft:cx+1,marginTop:cw+1})})}if(L.inverted){I(cy.childNodes,function(cJ){cD.invertChild(cJ,cy)})}if(cy.tagName==="SPAN"){var M,cI=L.rotation,cA,cC=b8(L.textWidth),cH=[cI,cB,cy.innerHTML,L.textWidth].join(",");if(cH!==L.cTT){cA=cD.fontMetrics(cy.style.fontSize).b;if(an(cI)){L.setSpanRotation(cI,cE,cA)}M=a0(L.elemWidth,cy.offsetWidth);if(M>cC&&/[ \-]/.test(cy.textContent||cy.innerText)){cp(cy,{width:cC+ab,display:"block",whiteSpace:"normal"});M=cC}L.getSpanCorrection(M,cA,cE,cI,cB)}cp(cy,{left:(cG+(L.xCorr||0))+ab,top:(cF+(L.yCorr||0))+ab});if(N){cA=cy.offsetHeight}L.cTT=cH}},setSpanRotation:function(cw,M,cy){var cx={},L=q?"-ms-transform":N?"-webkit-transform":bG?"MozTransform":aE?"-o-transform":"";cx[L]=cx.transform="rotate("+cw+"deg)";cx[L+(bG?"Origin":"-origin")]=cx.transformOrigin=(M*100)+"% "+cy+"px";cp(this.element,cx)},getSpanCorrection:function(M,cw,L){this.xCorr=-M*L;this.yCorr=-cw}});bD(d.prototype,{html:function(cy,L,cA){var cz=this.createElement("span"),M=cz.attrSetters,cw=cz.element,cx=cz.renderer;M.text=function(cB){if(cB!==cw.innerHTML){delete this.bBox}cw.innerHTML=this.textStr=cB;return false};M.x=M.y=M.align=M.rotation=function(cC,cB){if(cB==="align"){cB="textAlign"}cz[cB]=cC;cz.htmlUpdateTransform();return false};cz.attr({text:cy,x:o(L),y:o(cA)}).css({position:ax,whiteSpace:"nowrap",fontFamily:this.style.fontFamily,fontSize:this.style.fontSize});cz.css=cz.htmlCss;if(cx.isSVG){cz.add=function(cE){var cD,cB=cx.box.parentNode,cF,cC=[];this.parentGroup=cE;if(cE){cD=cE.div;if(!cD){cF=cE;while(cF){cC.push(cF);cF=cF.parentGroup}I(cC.reverse(),function(cH){var cG;cD=cH.div=cH.div||bF(P,{className:V(cH.element,"class")},{position:ax,left:(cH.translateX||0)+ab,top:(cH.translateY||0)+ab},cD||cB);cG=cD.style;bD(cH.attrSetters,{translateX:function(cI){cG.left=cI+ab},translateY:function(cI){cG.top=cI+ab},visibility:function(cJ,cI){cG[cI]=cJ}})})}}else{cD=cB}cD.appendChild(cw);cz.added=true;if(cz.alignOnAdd){cz.htmlUpdateTransform()}return cz}}return cz}});var ct,K;if(!cl&&!bj){aZ.VMLElement=K={init:function(cx,cz){var cy=this,L=["<",cz,' filled="f" stroked="f"'],cw=["position: ",ax,";"],M=cz===P;if(cz==="shape"||M){cw.push("left:0;top:0;width:1px;height:1px;")}cw.push("visibility: ",M?ap:av);L.push(' style="',cw.join(""),'"/>');if(cz){L=M||cz==="span"||cz==="img"?L.join(""):cx.prepVML(L);cy.element=bF(L)}cy.renderer=cx;cy.attrSetters={}},add:function(cx){var cA=this,cz=cA.renderer,cw=cA.element,cy=cz.box,M=cx&&cx.inverted,L=cx?cx.element||cx:cy;if(M){cz.invertChild(cw,L)}L.appendChild(cw);cA.added=true;if(cA.alignOnAdd&&!cA.deferUpdateTransform){cA.updateTransform()}if(cA.onAdd){cA.onAdd()}return cA},updateTransform:aH.prototype.htmlUpdateTransform,setSpanRotation:function(){var M=this.rotation,L=cm(M*aI),cw=ag(M*aI);cp(this.element,{filter:M?["progid:DXImageTransform.Microsoft.Matrix(M11=",L,", M12=",-cw,", M21=",cw,", M22=",L,", sizingMethod='auto expand')"].join(""):B})},getSpanCorrection:function(L,cx,cz,cD,cw){var cA=cD?cm(cD*aI):1,M=cD?ag(cD*aI):0,cC=a0(this.elemHeight,this.element.offsetHeight),cB,cy=cw&&cw!=="left";this.xCorr=cA<0&&-L;this.yCorr=M<0&&-cC;cB=cA*M<0;this.xCorr+=M*cx*(cB?1-cz:cz);this.yCorr-=cA*cx*(cD?(cB?cz:1-cz):1);if(cy){this.xCorr-=L*cz*(cA<0?-1:1);if(cD){this.yCorr-=cC*cz*(M<0?-1:1)}cp(this.element,{textAlign:cw})}},pathToVML:function(M){var L=M.length,cw=[];while(L--){if(aD(M[L])){cw[L]=o(M[L]*10)-5}else{if(M[L]==="Z"){cw[L]="x"}else{cw[L]=M[L];if(M.isArc&&(M[L]==="wa"||M[L]==="at")){if(cw[L+5]===cw[L+7]){cw[L+7]+=M[L+7]>M[L+5]?1:-1}if(cw[L+6]===cw[L+8]){cw[L+8]+=M[L+8]>M[L+6]?1:-1}}}}}return cw.join(" ")||"x"},attr:function(cw,cL){var cz=this,cJ,cE,cG,cD,cx=cz.element||{},cH=cx.style,L=cx.nodeName,cF=cz.renderer,cB=cz.symbolName,cA,M=cz.shadows,cC,cK=cz.attrSetters,cI=cz;if(bK(cw)&&an(cL)){cJ=cw;cw={};cw[cJ]=cL}if(bK(cw)){cJ=cw;if(cJ==="strokeWidth"||cJ==="stroke-width"){cI=cz.strokeweight}else{cI=cz[cJ]}}else{for(cJ in cw){cE=cw[cJ];cC=false;cD=cK[cJ]&&cK[cJ].call(cz,cE,cJ);if(cD!==false&&cE!==null){if(cD!==k){cE=cD}if(cB&&/^(x|y|r|start|end|width|height|innerR|anchorX|anchorY)/.test(cJ)){if(!cA){cz.symbolAttr(cw);cA=true}cC=true}else{if(cJ==="d"){cE=cE||[];cz.d=cE.join(" ");cx.path=cE=cz.pathToVML(cE);if(M){cG=M.length;while(cG--){M[cG].path=M[cG].cutOff?this.cutOffPath(cE,M[cG].cutOff):cE}}cC=true}else{if(cJ==="visibility"){if(cE==="inherit"){cE=av}if(M){cG=M.length;while(cG--){M[cG].style[cJ]=cE}}if(L==="DIV"){cE=cE===ap?"-999em":0;if(!E){cH[cJ]=cE?av:ap}cJ="top"}cH[cJ]=cE;cC=true}else{if(cJ==="zIndex"){if(cE){cH[cJ]=cE}cC=true}else{if(A(cJ,["x","y","width","height"])!==-1){cz[cJ]=cE;if(cJ==="x"||cJ==="y"){cJ={x:"left",y:"top"}[cJ]}else{cE=cu(0,cE)}if(cz.updateClipping){cz[cJ]=cE;cz.updateClipping()}else{cH[cJ]=cE}cC=true}else{if(cJ==="class"&&L==="DIV"){cx.className=cE}else{if(cJ==="stroke"){cE=cF.color(cE,cx,cJ);cJ="strokecolor"}else{if(cJ==="stroke-width"||cJ==="strokeWidth"){cx.stroked=cE?true:false;cJ="strokeweight";cz[cJ]=cE;if(aD(cE)){cE+=ab}}else{if(cJ==="dashstyle"){var cy=cx.getElementsByTagName("stroke")[0]||bF(cF.prepVML(["<stroke/>"]),null,null,cx);cy[cJ]=cE||"solid";cz.dashstyle=cE;cC=true}else{if(cJ==="fill"){if(L==="SPAN"){cH.color=cE}else{if(L!=="IMG"){cx.filled=cE!==B?true:false;cE=cF.color(cE,cx,cJ,cz);cJ="fillcolor"}}}else{if(cJ==="opacity"){cC=true}else{if(L==="shape"&&cJ==="rotation"){cz[cJ]=cx.style[cJ]=cE;cx.style.left=-o(ag(cE*aI)+1)+ab;cx.style.top=o(cm(cE*aI))+ab}else{if(cJ==="translateX"||cJ==="translateY"||cJ==="rotation"){cz[cJ]=cE;cz.updateTransform();cC=true}}}}}}}}}}}}}if(!cC){if(E){cx[cJ]=cE}else{V(cx,cJ,cE)}}}}}return cI},clip:function(L){var cx=this,cw,M;if(L){cw=L.members;T(cw,cx);cw.push(cx);cx.destroyClip=function(){T(cw,cx)};M=L.getCSS(cx)}else{if(cx.destroyClip){cx.destroyClip()}M={clip:E?"inherit":"rect(auto)"}}return cx.css(M)},css:aH.prototype.htmlCss,safeRemoveChild:function(L){if(L.parentNode){ca(L)}},destroy:function(){if(this.destroyClip){this.destroyClip()}return aH.prototype.destroy.apply(this)},on:function(L,M){this.element["on"+L]=function(){var cw=bf.event;cw.target=cw.srcElement;M(cw)};return this},cutOffPath:function(cw,M){var L;cw=cw.split(/[ ,]/);L=cw.length;if(L===9||L===11){cw[L-4]=cw[L-2]=b8(cw[L-2])-10*M}return cw.join(" ")},shadow:function(cG,cF,M){var cy=[],cz,cA=this.element,cB=this.renderer,cE,cw=cA.style,cH,cI=cA.path,cC,L,cx,cD;if(cI&&typeof cI.value!=="string"){cI="x"}L=cI;if(cG){cx=a0(cG.width,3);cD=(cG.opacity||0.15)/cx;for(cz=1;cz<=3;cz++){cC=(cx*2)+1-(2*cz);if(M){L=this.cutOffPath(cI.value,cC+0.5)}cH=['<shape isShadow="true" strokeweight="',cC,'" filled="false" path="',L,'" coordsize="10 10" style="',cA.style.cssText,'" />'];cE=bF(cB.prepVML(cH),null,{left:b8(cw.left)+a0(cG.offsetX,1),top:b8(cw.top)+a0(cG.offsetY,1)});if(M){cE.cutOff=cC+1}cH=['<stroke color="',cG.color||"black",'" opacity="',cD*cz,'"/>'];bF(cB.prepVML(cH),null,null,cE);if(cF){cF.element.appendChild(cE)}else{cA.parentNode.insertBefore(cE,cA)}cy.push(cE)}this.shadows=cy}return this}};K=bA(aH,K);var a3={Element:K,isIE8:u.indexOf("MSIE 8.0")>-1,init:function(M,cw,cC,L){var cB=this,cz,cx,cy;cB.alignedObjects=[];cz=cB.createElement(P).css(bD(this.getStyle(L),{position:O}));cx=cz.element;M.appendChild(cz.element);cB.isVML=true;cB.box=cx;cB.boxWrapper=cz;cB.cache={};cB.setSize(cw,cC,false);if(!bW.namespaces.hcv){bW.namespaces.add("hcv","urn:schemas-microsoft-com:vml");cy="hcv\\:fill, hcv\\:path, hcv\\:shape, hcv\\:stroke{ behavior:url(#default#VML); display: inline-block; } ";try{bW.createStyleSheet().cssText=cy}catch(cA){bW.styleSheets[0].cssText+=cy}}},isHidden:function(){return !this.box.offsetWidth},clipRect:function(M,cz,cy,L){var cx=this.createElement(),cw=cr(M);return bD(cx,{members:[],left:(cw?M.x:M)+1,top:(cw?M.y:cz)+1,width:(cw?M.width:cy)-1,height:(cw?M.height:L)-1,getCSS:function(cB){var cE=cB.element,cJ=cE.nodeName,cF=cJ==="shape",cD=cB.inverted,cI=this,cH=cI.top-(cF?cE.offsetTop:0),cC=cI.left,cK=cC+cI.width,cA=cH+cI.height,cG={clip:"rect("+o(cD?cC:cH)+"px,"+o(cD?cA:cK)+"px,"+o(cD?cK:cA)+"px,"+o(cD?cH:cC)+"px)"};if(!cD&&E&&cJ==="DIV"){bD(cG,{width:cK+ab,height:cA+ab})}return cG},updateClipping:function(){I(cx.members,function(cA){cA.css(cx.getCSS(cA))})}})},color:function(cQ,c3,cH,cJ){var cX=this,cO,cY=/^rgba/,cZ,cC,cU=B;if(cQ&&cQ.linearGradient){cC="gradient"}else{if(cQ&&cQ.radialGradient){cC="pattern"}}if(cC){var cL,cw,cG=cQ.linearGradient||cQ.radialGradient,cF,c5,cE,c4,cT,cS,cN,cM,cV="",cP=cQ.stops,c2,cR,c0=[],M=function(){cZ=['<fill colors="'+c0.join(",")+'" opacity="',cS,'" o:opacity2="',cT,'" type="',cC,'" ',cV,'focus="100%" method="any" />'];bF(cX.prepVML(cZ),null,null,c3)};c2=cP[0];cR=cP[cP.length-1];if(c2[0]>0){cP.unshift([0,c2[1]])}if(cR[0]<1){cP.push([1,cR[1]])}I(cP,function(cy,cx){if(cY.test(cy[1])){cO=b6(cy[1]);cL=cO.get("rgb");cw=cO.get("a")}else{cL=cy[1];cw=1}c0.push((cy[0]*100)+"% "+cL);if(!cx){cT=cw;cM=cL}else{cS=cw;cN=cL}});if(cH==="fill"){if(cC==="gradient"){cF=cG.x1||cG[0]||0;c5=cG.y1||cG[1]||0;cE=cG.x2||cG[2]||0;c4=cG.y2||cG[3]||0;cV='angle="'+(90-a8.atan((c4-c5)/(cE-cF))*180/S)+'"';M()}else{var c1=cG.r,cB=c1*2,cA=c1*2,cK=cG.cx,cI=cG.cy,cD=c3.radialReference,L,cW=function(){if(cD){L=cJ.getBBox();cK+=(cD[0]-L.x)/L.width-0.5;cI+=(cD[1]-L.y)/L.height-0.5;cB*=cD[2]/L.width;cA*=cD[2]/L.height}cV='src="'+bS.global.VMLRadialGradientURL+'" size="'+cB+","+cA+'" origin="0.5,0.5" position="'+cK+","+cI+'" color2="'+cM+'" ';M()};if(cJ.added){cW()}else{cJ.onAdd=cW}cU=cN}}else{cU=cL}}else{if(cY.test(cQ)&&c3.tagName!=="IMG"){cO=b6(cQ);cZ=["<",cH,' opacity="',cO.get("a"),'"/>'];bF(this.prepVML(cZ),null,null,c3);cU=cO.get("rgb")}else{var cz=c3.getElementsByTagName(cH);if(cz.length){cz[0].opacity=1;cz[0].type="solid"}cU=cQ}}return cU},prepVML:function(L){var M="display:inline-block;behavior:url(#default#VML);",cw=this.isIE8;L=L.join("");if(cw){L=L.replace("/>",' xmlns="urn:schemas-microsoft-com:vml" />');if(L.indexOf('style="')===-1){L=L.replace("/>",' style="'+M+'" />')}else{L=L.replace('style="','style="'+M)}}else{L=L.replace("<","<hcv:")}return L},text:d.prototype.html,path:function(M){var L={coordsize:"10 10"};if(aP(M)){L.d=M}else{if(cr(M)){bD(L,M)}}return this.createElement("shape").attr(L)},circle:function(L,cx,M){var cw=this.symbol("circle");if(cr(L)){M=L.r;cx=L.y;L=L.x}cw.isCircle=true;cw.r=M;return cw.attr({x:L,y:cx})},g:function(L){var cw,M;if(L){M={className:bk+L,"class":bk+L}}cw=this.createElement(P).attr(M);return cw},image:function(cy,M,cz,cw,L){var cx=this.createElement("img").attr({src:cy});if(arguments.length>1){cx.attr({x:M,y:cz,width:cw,height:L})}return cx},createElement:function(L){return L==="rect"?this.symbol(L):d.prototype.createElement.call(this,L)},invertChild:function(cw,L){var cy=this,cx=L.style,M=cw.tagName==="IMG"&&cw.style;cp(cw,{flip:"x",left:b8(cx.width)-(M?b8(M.top):1),top:b8(cx.height)-(M?b8(M.left):1),rotation:-90});I(cw.childNodes,function(cz){cy.invertChild(cz,cw)})},symbols:{arc:function(cE,cD,cG,cy,cH){var cw=cH.start,cx=cH.end,cA=cH.r||cG||cy,cC=cH.innerR,cz=cm(cw),L=ag(cw),M=cm(cx),cF=ag(cx),cB;if(cx-cw===0){return["x"]}cB=["wa",cE-cA,cD-cA,cE+cA,cD+cA,cE+cA*cz,cD+cA*L,cE+cA*M,cD+cA*cF];if(cH.open&&!cC){cB.push("e",bN,cE,cD)}cB.push("at",cE-cC,cD-cC,cE+cC,cD+cC,cE+cC*M,cD+cC*cF,cE+cC*cz,cD+cC*L,"x","e");cB.isArc=true;return cB},circle:function(L,cy,M,cw,cx){if(cx){M=cw=2*cx.r}if(cx&&cx.isCircle){L-=M/2;cy-=cw/2}return["wa",L,cy,L+M,cy+cw,L+M,cy+cw/2,L+M,cy+cw/2,"e"]},rect:function(cx,cz,cw,cB,cC){var cA=cx+cw,M=cz+cB,cy,L;if(!an(cC)||!cC.r){cy=d.prototype.symbols.square.apply(0,arguments)}else{L=aw(cC.r,cw,cB);cy=[bN,cx+L,cz,bO,cA-L,cz,"wa",cA-2*L,cz,cA,cz+2*L,cA-L,cz,cA,cz+L,bO,cA,M-L,"wa",cA-2*L,M-2*L,cA,M,cA,M-L,cA-L,M,bO,cx+L,M,"wa",cx,M-2*L,cx+2*L,M,cx+L,M,cx,M-L,bO,cx,cz+L,"wa",cx,cz,cx+2*L,cz+2*L,cx,cz+L,cx+L,cz,"x","e"]}return cy}}};aZ.VMLRenderer=ct=function(){this.init.apply(this,arguments)};ct.prototype=aY(d.prototype,a3);cf=ct}d.prototype.measureSpanWidth=function(cy,M){var cw=bW.createElement("span"),L,cx=bW.createTextNode(cy);cw.appendChild(cx);cp(cw,M);this.box.appendChild(cw);L=cw.offsetWidth;ca(cw);return L};var cs,bi;if(bj){aZ.CanVGRenderer=cs=function(){bd="http://www.w3.org/1999/xhtml"};cs.prototype.symbols={};bi=(function(){var M=[];function L(){var cx=M.length,cw;for(cw=0;cw<cx;cw++){M[cw]()}M=[]}return{push:function(cx,cw){if(M.length===0){br(cw,L)}M.push(cx)}}}());cf=cs}function aJ(cw,cx,M,L){this.axis=cw;this.pos=cx;this.type=M||"";this.isNew=true;if(!M&&!L){this.addLabel()}}aJ.prototype={addLabel:function(){var cL=this,M=cL.axis,cw=M.options,cD=M.chart,cM=M.horiz,cF=M.categories,cC=M.names,cx=cL.pos,cE=cw.labels,cI,cN=M.tickPositions,cG=(cM&&cF&&!cE.step&&!cE.staggerLines&&!cE.rotation&&cD.plotWidth/cN.length)||(!cM&&(cD.margin[3]||cD.chartWidth*0.33)),cz=cx===cN[0],cB=cx===cN[cN.length-1],cA,cJ,cH=cF?a0(cF[cx],cC[cx],cx):cx,cy=cL.label,cK=cN.info,L;if(M.isDatetimeAxis&&cK){L=cw.dateTimeLabelFormats[cK.higherRanks[cx]||cK.unitName]}cL.isFirst=cz;cL.isLast=cB;cI=M.labelFormatter.call({axis:M,chart:cD,isFirst:cz,isLast:cB,dateTimeLabelFormat:L,value:M.isLog?al(y(cH)):cH});if(cz){cI="<span class='highcharts-first-label'>"+cI+"</span>"}else{if(cB){cI="<span class='highcharts-last-label'>"+cI+"</span>"}}cA=cG&&{width:cu(1,o(cG-2*(cE.padding||10)))+ab};cA=bD(cA,cE.style);if(!an(cy)){cJ={align:M.labelAlign};if(aD(cE.rotation)){cJ.rotation=cE.rotation}if(cG&&cE.ellipsis){cJ._clipHeight=M.len/cN.length}cL.label=an(cI)&&cE.enabled?cD.renderer.text(cI,0,0,cE.useHTML).attr(cJ).css(cA).add(M.labelGroup):null}else{if(cy){cy.attr({text:cI}).css(cA)}}},getLabelSize:function(){var L=this.label,M=this.axis;return L?L.getBBox()[M.horiz?"height":"width"]:0},getLabelSides:function(){var cz=this.label.getBBox(),cy=this.axis,cB=cy.horiz,M=cy.options,L=M.labels,cw=cB?cz.width:cz.height,cx=cB?L.x-cw*{left:0,center:0.5,right:1}[cy.labelAlign]:0,cA=cB?cw+cx:cw;return[cx,cA]},handleOverflow:function(cC,cA){var cN=true,cy=this.axis,cE=this.isFirst,cG=this.isLast,cM=cy.horiz,cI=cM?cA.x:cA.y,cx=cy.reversed,cO=cy.tickPositions,cL=this.getLabelSides(),cD=cL[0],cK=cL[1],cH,M,cJ,cz,cF=this.label.line||0,L=cy.labelEdge,cB=cy.justifyLabels&&(cE||cG),cw;if(L[cF]===k||cI+cD>L[cF]){L[cF]=cI+cK}else{if(!cB){cN=false}}if(cB){cw=cy.justifyToPlot;cH=cw?cy.pos:0;M=cw?cH+cy.len:cy.chart.chartWidth;do{cC+=(cE?1:-1);cJ=cy.ticks[cO[cC]]}while(cO[cC]&&(!cJ||cJ.label.line!==cF));cz=cJ&&cJ.label.xy&&cJ.label.xy.x+cJ.getLabelSides()[cE?0:1];if((cE&&!cx)||(cG&&cx)){if(cI+cD<cH){cI=cH-cD;if(cJ&&cI+cK>cz){cN=false}}}else{if(cI+cK>M){cI=M-cK;if(cJ&&cI+cD<cz){cN=false}}}cA.x=cI}return cN},getPosition:function(cA,cz,cy,L){var cx=this.axis,cw=cx.chart,M=(L&&cw.oldChartHeight)||cw.chartHeight;return{x:cA?cx.translate(cz+cy,null,null,L)+cx.transB:cx.left+cx.offset+(cx.opposite?((L&&cw.oldChartWidth)||cw.chartWidth)-cx.right-cx.left:0),y:cA?M-cx.bottom+cx.offset-(cx.opposite?cx.height:0):M-cx.translate(cz+cy,null,null,L)-cx.transB}},getLabelPosition:function(cE,cC,cD,cG,cy,cz,cA,L){var M=this.axis,cx=M.transA,cw=M.reversed,cH=M.staggerLines,cB=M.chart.renderer.fontMetrics(cy.style.fontSize).b,cF=cy.rotation;cE=cE+cy.x-(cz&&cG?cz*cx*(cw?-1:1):0);cC=cC+cy.y-(cz&&!cG?cz*cx*(cw?1:-1):0);if(cF&&M.side===2){cC-=cB-cB*cm(cF*aI)}if(!an(cy.y)&&!cF){cC+=cB-cD.getBBox().height/2}if(cH){cD.line=(cA/(L||1)%cH);cC+=cD.line*(M.labelOffset/cH)}return{x:cE,y:cC}},getMarkPath:function(M,cz,cw,L,cy,cx){return cx.crispLine([bN,M,cz,bO,M+(cy?0:-cw),cz+(cy?cw:0)],L)},render:function(cE,M,cy){var cX=this,cx=cX.axis,cz=cx.options,cQ=cx.chart,cW=cQ.renderer,cZ=cx.horiz,cA=cX.type,cI=cX.label,cD=cX.pos,cT=cz.labels,cF=cX.gridLine,cS=cA?cA+"Grid":"grid",cV=cA?cA+"Tick":"tick",cR=cz[cS+"LineWidth"],cU=cz[cS+"LineColor"],cH=cz[cS+"LineDashStyle"],cw=cz[cV+"Length"],cG=cz[cV+"Width"]||0,cN=cz[cV+"Color"],cO=cz[cV+"Position"],c0,cL=cX.mark,L,cC=cT.step,cP,cY=true,c1=cx.tickmarkOffset,cB=cX.getPosition(cZ,cD,c1,M),cM=cB.x,cK=cB.y,cJ=((cZ&&cM===cx.pos+cx.len)||(!cZ&&cK===cx.pos))?-1:1;this.isActive=true;if(cR){c0=cx.getPlotLinePath(cD+c1,cR*cJ,M,true);if(cF===k){cP={stroke:cU,"stroke-width":cR};if(cH){cP.dashstyle=cH}if(!cA){cP.zIndex=1}if(M){cP.opacity=0}cX.gridLine=cF=cR?cW.path(c0).attr(cP).add(cx.gridGroup):null}if(!M&&cF&&c0){cF[cX.isNew?"attr":"animate"]({d:c0,opacity:cy})}}if(cG&&cw){if(cO==="inside"){cw=-cw}if(cx.opposite){cw=-cw}L=cX.getMarkPath(cM,cK,cw,cG*cJ,cZ,cW);if(cL){cL.animate({d:L,opacity:cy})}else{cX.mark=cW.path(L).attr({stroke:cN,"stroke-width":cG,opacity:cy}).add(cx.axisGroup)}}if(cI&&!isNaN(cM)){cI.xy=cB=cX.getLabelPosition(cM,cK,cI,cZ,cT,c1,cE,cC);if((cX.isFirst&&!cX.isLast&&!a0(cz.showFirstLabel,1))||(cX.isLast&&!cX.isFirst&&!a0(cz.showLastLabel,1))){cY=false}else{if(!cx.isRadial&&!cT.step&&!cT.rotation&&!M&&cy!==0){cY=cX.handleOverflow(cE,cB)}}if(cC&&cE%cC){cY=false}if(cY&&!isNaN(cB.y)){cB.opacity=cy;cI[cX.isNew?"attr":"animate"](cB);cX.isNew=false}else{cI.attr("y",-9999)}}},destroy:function(){bp(this,this.axis)}};aZ.PlotLineOrBand=function(M,L){this.axis=M;if(L){this.options=L;this.id=L.id}};aZ.PlotLineOrBand.prototype={render:function(){var cS=this,cy=cS.axis,cT=cy.horiz,cx=(cy.pointRange||0)/2,cz=cS.options,L=cz.label,cB=cS.label,cK=cz.width,cw=cz.to,cQ=cz.from,cJ=an(cQ)&&an(cw),cM=cz.value,cA=cz.dashStyle,cO=cS.svgElem,cI=[],cN,cF,cC,cR,cE,cD,cP=cz.color,cH=cz.zIndex,M=cz.events,cG,cL=cy.chart.renderer;if(cy.isLog){cQ=v(cQ);cw=v(cw);cM=v(cM)}if(cK){cI=cy.getPlotLinePath(cM,cK);cG={stroke:cP,"stroke-width":cK};if(cA){cG.dashstyle=cA}}else{if(cJ){cQ=cu(cQ,cy.min-cx);cw=aw(cw,cy.max+cx);cI=cy.getPlotBandPath(cQ,cw,cz);cG={fill:cP};if(cz.borderWidth){cG.stroke=cz.borderColor;cG["stroke-width"]=cz.borderWidth}}else{return}}if(an(cH)){cG.zIndex=cH}if(cO){if(cI){cO.animate({d:cI},null,cO.onGetPath)}else{cO.hide();cO.onGetPath=function(){cO.show()};if(cB){cS.label=cB=cB.destroy()}}}else{if(cI&&cI.length){cS.svgElem=cO=cL.path(cI).attr(cG).add();if(M){cN=function(cU){cO.on(cU,function(cV){M[cU].apply(cS,[cV])})};for(cF in M){cN(cF)}}}}if(L&&an(L.text)&&cI&&cI.length&&cy.width>0&&cy.height>0){L=aY({align:cT&&cJ&&"center",x:cT?!cJ&&4:10,verticalAlign:!cT&&cJ&&"middle",y:cT?cJ?16:10:cJ?6:-4,rotation:cT&&!cJ&&90},L);if(!cB){cS.label=cB=cL.text(L.text,0,0,L.useHTML).attr({align:L.textAlign||L.align,rotation:L.rotation,zIndex:cH}).css(L.style).add()}cC=[cI[1],cI[4],a0(cI[6],cI[1])];cR=[cI[2],cI[5],a0(cI[7],cI[2])];cE=bY(cC);cD=bY(cR);cB.align(L,false,{x:cE,y:cD,width:aS(cC)-cE,height:aS(cR)-cD});cB.show()}else{if(cB){cB.hide()}}return cS},destroy:function(){T(this.axis.plotLinesAndBands,this);delete this.axis;bp(this)}};r={getPlotBandPath:function(cx,cw){var L=this.getPlotLinePath(cw),M=this.getPlotLinePath(cx);if(M&&L){M.push(L[4],L[5],L[1],L[2])}else{M=null}return M},addPlotBand:function(L){this.addPlotBandOrLine(L,"plotBands")},addPlotLine:function(L){this.addPlotBandOrLine(L,"plotLines")},addPlotBandOrLine:function(L,M){var cw=new aZ.PlotLineOrBand(this,L).render(),cx=this.userOptions;if(cw){if(M){cx[M]=cx[M]||[];cx[M].push(L)}this.plotLinesAndBands.push(cw)}return cw},removePlotBandOrLine:function(cy){var L=this.plotLinesAndBands,M=this.options,cx=this.userOptions,cw=L.length;while(cw--){if(L[cw].id===cy){L[cw].destroy()}}I([M.plotLines||[],cx.plotLines||[],M.plotBands||[],cx.plotBands||[]],function(cz){cw=cz.length;while(cw--){if(cz[cw].id===cy){T(cz,cz[cw])}}})}};function C(){this.init.apply(this,arguments)}C.prototype={defaultOptions:{dateTimeLabelFormats:{millisecond:"%H:%M:%S.%L",second:"%H:%M:%S",minute:"%H:%M",hour:"%H:%M",day:"%e. %b",week:"%e. %b",month:"%b '%y",year:"%Y"},endOnTick:false,gridLineColor:"#C0C0C0",labels:w,lineColor:"#C0D0E0",lineWidth:1,minPadding:0.01,maxPadding:0.01,minorGridLineColor:"#E0E0E0",minorGridLineWidth:1,minorTickColor:"#A0A0A0",minorTickLength:2,minorTickPosition:"outside",startOfWeek:1,startOnTick:false,tickColor:"#C0D0E0",tickLength:5,tickmarkPlacement:"between",tickPixelInterval:100,tickPosition:"outside",tickWidth:1,title:{align:"middle",style:{color:"#4d759e",fontWeight:"bold"}},type:"linear"},defaultYAxisOptions:{endOnTick:true,gridLineWidth:1,tickPixelInterval:72,showLastLabel:true,labels:{x:-8,y:3},lineWidth:0,maxPadding:0.05,minPadding:0.05,startOnTick:true,tickWidth:0,title:{rotation:270,text:"Values"},stackLabels:{enabled:false,formatter:function(){return m(this.total,-1)},style:w.style}},defaultLeftAxisOptions:{labels:{x:-8,y:null},title:{rotation:270}},defaultRightAxisOptions:{labels:{x:8,y:null},title:{rotation:90}},defaultBottomAxisOptions:{labels:{x:0,y:14},title:{rotation:0}},defaultTopAxisOptions:{labels:{x:0,y:-5},title:{rotation:0}},init:function(cz,cy){var L=cy.isX,cx=this;cx.horiz=cz.inverted?!L:L;cx.isXAxis=L;cx.coll=L?"xAxis":"yAxis";cx.opposite=cy.opposite;cx.side=cy.side||(cx.horiz?(cx.opposite?0:2):(cx.opposite?1:3));cx.setOptions(cy);var cC=this.options,cA=cC.type,M=cA==="datetime";cx.labelFormatter=cC.labels.formatter||cx.defaultLabelFormatter;cx.userOptions=cy;cx.minPixelPadding=0;cx.chart=cz;cx.reversed=cC.reversed;cx.zoomEnabled=cC.zoomEnabled!==false;cx.categories=cC.categories||cA==="category";cx.names=[];cx.isLog=cA==="logarithmic";cx.isDatetimeAxis=M;cx.isLinked=an(cC.linkedTo);cx.tickmarkOffset=(cx.categories&&cC.tickmarkPlacement==="between")?0.5:0;cx.ticks={};cx.labelEdge=[];cx.minorTicks={};cx.plotLinesAndBands=[];cx.alternateBands={};cx.len=0;cx.minRange=cx.userMinRange=cC.minRange||cC.maxZoom;cx.range=cC.range;cx.offset=cC.offset||0;cx.stacks={};cx.oldStacks={};cx.max=null;cx.min=null;cx.crosshair=a0(cC.crosshair,bw(cz.options.tooltip.crosshairs)[L?0:1],false);var cw,cB=cx.options.events;if(A(cx,cz.axes)===-1){if(L&&!this.isColorAxis){cz.axes.splice(cz.xAxis.length,0,cx)}else{cz.axes.push(cx)}cz[cx.coll].push(cx)}cx.series=cx.series||[];if(cz.inverted&&L&&cx.reversed===k){cx.reversed=true}cx.removePlotBand=cx.removePlotBandOrLine;cx.removePlotLine=cx.removePlotBandOrLine;for(cw in cB){z(cx,cw,cB[cw])}if(cx.isLog){cx.val2lin=v;cx.lin2val=y}},setOptions:function(L){this.options=aY(this.defaultOptions,this.isXAxis?{}:this.defaultYAxisOptions,[this.defaultTopAxisOptions,this.defaultRightAxisOptions,this.defaultBottomAxisOptions,this.defaultLeftAxisOptions][this.side],aY(bS[this.coll],L))},defaultLabelFormatter:function(){var M=this.axis,cD=this.value,cz=M.categories,cC=this.dateTimeLabelFormat,cx=bS.lang.numericSymbols,cy=cx&&cx.length,cA,cB,cw=M.options.labels.format,L=M.isLog?cD:M.tickInterval;if(cw){cB=g(cw,this)}else{if(cz){cB=cD}else{if(cC){cB=cb(cC,cD)}else{if(cy&&L>=1000){while(cy--&&cB===k){cA=Math.pow(1000,cy+1);if(L>=cA&&cx[cy]!==null){if(M.options&&M.options.labels&&M.options.labels.isMoney){cB=m(cD/cA,-1,undefined,undefined,true)+cx[cy]}else{cB=m(cD/cA,-1)+cx[cy]}}}}}}}if(cB===k){if(cD>=10000){cB=m(cD,0)}else{cB=m(cD,-1,k,"")}}return cB},getSeriesExtremes:function(){var M=this,L=M.chart;M.hasVisibleSeries=false;M.dataMin=M.dataMax=null;if(M.buildStacks){M.buildStacks()}I(M.series,function(cy){if(cy.visible||!L.options.chart.ignoreHiddenSeries){var cx=cy.options,cA,cw=cx.threshold,cB,cz;M.hasVisibleSeries=true;if(M.isLog&&cw<=0){cw=null}if(M.isXAxis){cA=cy.xData;if(cA.length){M.dataMin=aw(a0(M.dataMin,cA[0]),bY(cA));M.dataMax=cu(a0(M.dataMax,cA[0]),aS(cA))}}else{cy.getExtremes();cz=cy.dataMax;cB=cy.dataMin;if(an(cB)&&an(cz)){M.dataMin=aw(a0(M.dataMin,cB),cB);M.dataMax=cu(a0(M.dataMax,cz),cz)}if(an(cw)){if(M.dataMin>=cw){M.dataMin=cw;M.ignoreMinPadding=true}else{if(M.dataMax<cw){M.dataMax=cw;M.ignoreMaxPadding=true}}}}}})},translate:function(M,cF,cG,cw,cE,cy){var cz=this,cx=1,cD=0,cA=cw?cz.oldTransA:cz.transA,cH=cw?cz.oldMin:cz.min,L,cB=cz.minPixelPadding,cC=(cz.options.ordinal||(cz.isLog&&cE))&&cz.lin2val;if(!cA){cA=cz.transA}if(cG){cx*=-1;cD=cz.len}if(cz.reversed){cx*=-1;cD-=cx*(cz.sector||cz.len)}if(cF){M=M*cx+cD;M-=cB;L=M/cA+cH;if(cC){L=cz.lin2val(L)}}else{if(cC){M=cz.val2lin(M)}if(cy==="between"){cy=0.5}L=cx*(M-cH)*cA+cD+(cx*cB)+(aD(cy)?cA*cy*cz.pointRange:0)}return L},toPixels:function(M,L){return this.translate(M,false,!this.horiz,null,true)+(L?0:this.pos)},toValue:function(L,M){return this.translate(L-(M?0:this.pos),true,!this.horiz,null,true)},getPlotLinePath:function(cJ,cE,cy,cx,cC){var cz=this,cG=cz.chart,cD=cz.left,L=cz.top,cw,cI,M,cH,cF=(cy&&cG.oldChartHeight)||cG.chartHeight,cA=(cy&&cG.oldChartWidth)||cG.chartWidth,cK,cB=cz.transB;cC=a0(cC,cz.translate(cJ,null,null,cy));cw=M=o(cC+cB);cI=cH=o(cF-cC-cB);if(isNaN(cC)){cK=true}else{if(cz.horiz){cI=L;cH=cF-cz.bottom;if(cw<cD||cw>cD+cz.width){cK=true}}else{cw=cD;M=cA-cz.right;if(cI<L||cI>L+cz.height){cK=true}}}return cK&&!cx?null:cG.renderer.crispLine([bN,cw,cI,bO,M,cH],cE||1)},getLinearTickPositions:function(M,cy,L){var cB,cA,cz=al(bE(cy/M)*M),cx=al(aK(L/M)*M),cw=[];cB=cz;while(cB<=cx){cw.push(cB);cB=al(cB+M);if(cB===cA){break}cA=cB}return cw},getMinorTickPositions:function(){var cy=this,cw=cy.options,M=cy.tickPositions,cA=cy.minorTickInterval,cz=[],cB,cx,L;if(cy.isLog){L=M.length;for(cx=1;cx<L;cx++){cz=cz.concat(cy.getLogTickPositions(cA,M[cx-1],M[cx],true))}}else{if(cy.isDatetimeAxis&&cw.minorTickInterval==="auto"){cz=cz.concat(cy.getTimeTicks(cy.normalizeTimeTickInterval(cA),cy.min,cy.max,cw.startOfWeek));if(cz[0]<cy.min){cz.shift()}}else{for(cB=cy.min+(M[0]-cy.min)%cA;cB<=cy.max;cB+=cA){cz.push(cB)}}}return cz},adjustForMinRange:function(){var cx=this,cH=cx.options,cz=cx.min,cE=cx.max,cG,cw=cx.dataMax-cx.dataMin>=cx.minRange,M,cB,L,cy,cD,cF,cC;if(cx.isXAxis&&cx.minRange===k&&!cx.isLog){if(an(cH.min)||an(cH.max)){cx.minRange=null}else{I(cx.series,function(cI){cy=cI.xData;cD=cI.xIncrement?1:cy.length-1;for(cB=cD;cB>0;cB--){L=cy[cB]-cy[cB-1];if(M===k||L<M){M=L}}});cx.minRange=aw(M*5,cx.dataMax-cx.dataMin)}}if(cE-cz<cx.minRange){var cA=cx.minRange;cG=(cA-cE+cz)/2;cF=[cz-cG,a0(cH.min,cz-cG)];if(cw){cF[2]=cx.dataMin}cz=aS(cF);cC=[cz+cA,a0(cH.max,cz+cA)];if(cw){cC[2]=cx.dataMax}cE=bY(cC);if(cE-cz<cA){cF[0]=cE-cA;cF[1]=a0(cH.min,cE-cA);cz=aS(cF)}}cx.min=cz;cx.max=cE},setAxisTranslation:function(cD){var M=this,cz=M.max-M.min,cC=M.axisPointRange||0,cE,cw=0,cA=0,cB=M.linkedParent,cy,L=!!M.categories,cx=M.transA;if(M.isXAxis||L||cC){if(cB){cw=cB.minPointOffset;cA=cB.pointRangePadding}else{I(M.series,function(cG){var cH=cu(M.isXAxis?cG.pointRange:(M.axisPointRange||0),+L),cI=cG.options.pointPlacement,cF=cG.closestPointRange;if(cH>cz){cH=0}cC=cu(cC,cH);cw=cu(cw,bK(cI)?0:cH/2);cA=cu(cA,cI==="on"?0:cH);if(!cG.noSharedTooltip&&an(cF)){cE=an(cE)?aw(cE,cF):cF}})}cy=M.ordinalSlope&&cE?M.ordinalSlope/cE:1;M.minPointOffset=cw=cw*cy;M.pointRangePadding=cA=cA*cy;M.pointRange=aw(cC,cz);M.closestPointRange=cE}if(cD){M.oldTransA=cx}M.translationSlope=M.transA=cx=M.len/((cz+cA)||1);M.transB=M.horiz?M.left:M.bottom;M.minPixelPadding=cx*cw},setTickPositions:function(cO){var cx=this,cJ=cx.chart,cy=cx.options,cH=cx.isLog,cF=cx.isDatetimeAxis,cG=cx.isXAxis,cB=cx.isLinked,M=cx.options.tickPositioner,cL=cy.maxPadding,cw=cy.minPadding,cz,cI,cC=cy.tickInterval,cN=cy.minTickInterval,cE=cy.tickPixelInterval,cQ,cA,cK=cx.categories;if(cB){cx.linkedParent=cJ[cx.coll][cy.linkedTo];cI=cx.linkedParent.getExtremes();cx.min=a0(cI.min,cI.dataMin);cx.max=a0(cI.max,cI.dataMax);if(cy.type!==cx.linkedParent.options.type){b9(11,1)}}else{cx.min=a0(cx.userMin,cy.min,cx.dataMin);cx.max=a0(cx.userMax,cy.max,cx.dataMax)}if(cH){if(!cO&&aw(cx.min,a0(cx.dataMin,cx.min))<=0){b9(10,1)}cx.min=al(v(cx.min));cx.max=al(v(cx.max))}if(cx.range&&an(cx.max)){cx.userMin=cx.min=cu(cx.min,cx.max-cx.range);cx.userMax=cx.max;cx.range=null}if(cx.beforePadding){cx.beforePadding()}cx.adjustForMinRange();if(!cK&&!cx.axisPointRange&&!cx.usePercentage&&!cB&&an(cx.min)&&an(cx.max)){cz=cx.max-cx.min;if(cz){if(!an(cy.min)&&!an(cx.userMin)&&cw&&(cx.dataMin<0||!cx.ignoreMinPadding)){cx.min-=cz*cw}if(!an(cy.max)&&!an(cx.userMax)&&cL&&(cx.dataMax>0||!cx.ignoreMaxPadding)){cx.max+=cz*cL}}}if(cx.min===cx.max||cx.min===undefined||cx.max===undefined){cx.tickInterval=cx.max/5}else{if(cB&&!cC&&cE===cx.linkedParent.options.tickPixelInterval){cx.tickInterval=cx.linkedParent.tickInterval}else{cx.tickInterval=a0(cC,cK?1:(cx.max-cx.min)*cE/cu(cx.len,cE));if(!an(cC)&&cx.len<cE&&!this.isRadial&&!this.isLog&&!cK&&cy.startOnTick&&cy.endOnTick){cA=true;cx.tickInterval/=4}}}if(cG&&!cO){I(cx.series,function(cR){cR.processData(cx.min!==cx.oldMin||cx.max!==cx.oldMax)})}cx.setAxisTranslation(true);if(cx.beforeSetTickPositions){cx.beforeSetTickPositions()}if(cx.postProcessTickInterval){cx.tickInterval=cx.postProcessTickInterval(cx.tickInterval)}if(cx.pointRange){cx.tickInterval=cu(cx.pointRange,cx.tickInterval)}if(!cC&&cx.tickInterval<cN){cx.tickInterval=cN}if(!cF&&!cH){if(!cC){cx.tickInterval=b1(cx.tickInterval,null,n(cx.tickInterval),cy)}}cx.minorTickInterval=cy.minorTickInterval==="auto"&&cx.tickInterval?cx.tickInterval/5:cy.minorTickInterval;cx.tickPositions=cQ=cy.tickPositions?[].concat(cy.tickPositions):(M&&M.apply(cx,[cx.min,cx.max]));if(!cQ){if(!cx.ordinalPositions&&(cx.max-cx.min)/cx.tickInterval>cu(2*cx.len,200)){b9(19,true)}if(cF){cQ=cx.getTimeTicks(cx.normalizeTimeTickInterval(cx.tickInterval,cy.units),cx.min,cx.max,cy.startOfWeek,cx.ordinalPositions,cx.closestPointRange,true)}else{if(cH){cQ=cx.getLogTickPositions(cx.tickInterval,cx.min,cx.max)}else{cQ=cx.getLinearTickPositions(cx.tickInterval,cx.min,cx.max)}}if(cA){cQ.splice(1,cQ.length-2)}cx.tickPositions=cQ}if(!cB){var cM=cQ[0],cP=cQ[cQ.length-1],cD=cx.minPointOffset||0,L;if(cy.startOnTick){cx.min=cM}else{if(cx.min-cD>cM){cQ.shift()}}if(cy.endOnTick){cx.max=cP}else{if(cx.max+cD<cP){cQ.pop()}}if(cQ.length===1){L=f(cx.max||1)*0.001;cx.min-=L;cx.max+=L}}},setMaxTicks:function(){var cw=this.chart,cx=cw.maxTicks||{},L=this.tickPositions,M=this._maxTicksKey=[this.coll,this.pos,this.len].join("-");if(!this.isLinked&&!this.isDatetimeAxis&&L&&L.length>(cx[M]||0)&&this.options.alignTicks!==false){cx[M]=L.length}if(this.options.forceTickRecalculate){cx[M]=L.length}cw.maxTicks=cx},adjustTickAmount:function(){var cz=this,cy=cz.chart,cx=cz._maxTicksKey,M=cz.tickPositions,cB=cy.maxTicks;if(!M){return}if(cB&&cB[cx]&&!cz.isDatetimeAxis&&!cz.categories&&!cz.isLinked&&cz.options.alignTicks!==false&&this.min!==k){var cA=cz.tickAmount,L=M.length,cw;cz.tickAmount=cw=cB[cx];if(L<cw){while(M.length<cw){M.push(al(M[M.length-1]+cz.tickInterval))}cz.transA*=(L-1)/(cw-1);cz.max=M[M.length-1]}if(an(cA)&&cw!==cA){cz.isDirty=true}}},setScale:function(){var cx=this,cw=cx.stacks,M,L,cz,cy;cx.oldMin=cx.min;cx.oldMax=cx.max;cx.oldAxisLength=cx.len;cx.setAxisSize();cy=cx.len!==cx.oldAxisLength;I(cx.series,function(cA){if(cA.isDirtyData||cA.isDirty||cA.xAxis.isDirty){cz=true}});if(cy||cz||cx.isLinked||cx.forceRedraw||cx.userMin!==cx.oldUserMin||cx.userMax!==cx.oldUserMax){if(!cx.isXAxis){for(M in cw){for(L in cw[M]){cw[M][L].total=null;cw[M][L].cum=0}}}cx.forceRedraw=false;cx.getSeriesExtremes();cx.setTickPositions();cx.oldUserMin=cx.userMin;cx.oldUserMax=cx.userMax;if(!cx.isDirty){cx.isDirty=cy||cx.min!==cx.oldMin||cx.max!==cx.oldMax}}else{if(!cx.isXAxis){if(cx.oldStacks){cw=cx.stacks=cx.oldStacks}for(M in cw){for(L in cw[M]){cw[M][L].cum=cw[M][L].total}}}}cx.setMaxTicks()},setExtremes:function(cA,cx,cB,cz,L){var cw=this,M=cw.chart;cB=a0(cB,true);L=bD(L,{min:cA,max:cx});var cy=function(){cw.userMin=cA;cw.userMax=cx;cw.eventArgs=L;cw.isDirtyExtremes=true;if(cB){M.redraw(cz)}};if(L.preventEventFire){cy()}else{bM(cw,"setExtremes",L,cy)}},zoom:function(cy,cw){var cx=this.dataMin,M=this.dataMax,L=this.options;if(!this.allowZoomOutside){if(an(cx)&&cy<=aw(cx,a0(L.min,cx))){cy=k}if(an(M)&&cw>=cu(M,a0(L.max,M))){cw=k}}this.displayBtn=cy!==k||cw!==k;this.setExtremes(cy,cw,false,k,{trigger:"zoom"});return true},setAxisSize:function(){var cy=this.chart,cC=this.options,cw=cC.offsetLeft||0,cx=cC.offsetRight||0,cB=this.horiz,L,cA,cz,M;this.left=M=a0(cC.left,cy.plotLeft+cw);this.top=cz=a0(cC.top,cy.plotTop);this.width=L=a0(cC.width,cy.plotWidth-cw+cx);this.height=cA=a0(cC.height,cy.plotHeight);this.bottom=cy.chartHeight-cA-cz;this.right=cy.chartWidth-L-M;this.len=cu(cB?L:cA,0);this.pos=cB?M:cz},getExtremes:function(){var M=this,L=M.isLog;return{min:L?al(y(M.min)):M.min,max:L?al(y(M.max)):M.max,dataMin:M.dataMin,dataMax:M.dataMax,userMin:M.userMin,userMax:M.userMax}},getThreshold:function(M){var cx=this,L=cx.isLog;var cy=L?y(cx.min):cx.min,cw=L?y(cx.max):cx.max;if(cy>M||M===null){M=cy}else{if(cw<M){M=cw}}return cx.translate(M,0,1,0,1)},autoLabelAlign:function(M){var L,cw=(a0(M,0)-(this.side*90)+720)%360;if(cw>15&&cw<165){L="right"}else{if(cw>195&&cw<345){L="left"}else{L="center"}}return L},getOffset:function(){var cy=this,cL=cy.chart,cP=cL.renderer,cA=cy.options,cY=cy.tickPositions,cZ=cy.ticks,cW=cy.horiz,cx=cy.side,cC=cL.inverted?[1,0,3,2][cx]:cx,cS,cN,M=0,cX,cF=0,cw=cA.title,cM=cA.labels,cR=0,cz=cL.axisOffset,cU=cL.clipOffset,cK=[-1,1,1,-1][cx],cO,cQ,cV=1,cT=a0(cM.maxStaggerLines,5),cE,cG,L,cB,cD,cH,cJ,cI;cy.hasData=cS=(cy.hasVisibleSeries||(an(cy.min)&&an(cy.max)&&!!cY));cy.showAxis=cN=cS||a0(cA.showEmpty,true);cy.staggerLines=cy.horiz&&cM.staggerLines;if(!cy.axisGroup){cy.gridGroup=cP.g("grid").attr({zIndex:cA.gridZIndex||1}).add();cy.axisGroup=cP.g("axis").attr({zIndex:cA.zIndex||2}).add();cy.labelGroup=cP.g("axis-labels").attr({zIndex:cM.zIndex||7}).addClass(bk+cy.coll.toLowerCase()+"-labels").add()}if(cS||cy.isLinked){cy.labelAlign=a0(cM.align||cy.autoLabelAlign(cM.rotation));I(cY,function(c0){if(!cZ[c0]){cZ[c0]=new aJ(cy,c0)}else{cZ[c0].addLabel()}});if(cy.horiz&&!cy.staggerLines&&cT&&!cM.rotation){cE=cy.reversed?[].concat(cY).reverse():cY;while(cV<cT){cG=[];L=false;for(cQ=0;cQ<cE.length;cQ++){cB=cE[cQ];cD=cZ[cB].label&&cZ[cB].label.getBBox();cJ=cD?cD.width:0;cI=cQ%cV;if(cJ){cH=cy.translate(cB);if(cG[cI]!==k&&cH<cG[cI]){L=true}cG[cI]=cH+cJ}}if(L){cV++}else{break}}if(cV>1){cy.staggerLines=cV}}I(cY,function(c0){if(cx===0||cx===2||{1:"left",3:"right"}[cx]===cy.labelAlign){cR=cu(cZ[c0].getLabelSize(),cR)}});if(cy.staggerLines){cR*=cy.staggerLines;cy.labelOffset=cR}}else{for(cO in cZ){cZ[cO].destroy();delete cZ[cO]}}if(cw&&cw.text&&cw.enabled!==false){if(!cy.axisTitle){cy.axisTitle=cP.text(cw.text,0,0,cw.useHTML).attr({zIndex:7,rotation:cw.rotation||0,align:cw.textAlign||{low:"left",middle:"center",high:"right"}[cw.align]}).addClass(bk+this.coll.toLowerCase()+"-title").css(cw.style).add(cy.axisGroup);cy.axisTitle.isNew=true}if(cN){M=cy.axisTitle.getBBox()[cW?"height":"width"];cF=a0(cw.margin,cW?5:10);cX=cw.offset}cy.axisTitle[cN?"show":"hide"]()}cy.offset=cK*a0(cA.offset,cz[cx]);cy.axisTitleMargin=a0(cX,cR+cF+(cx!==2&&cR&&cK*cA.labels[cW?"y":"x"]));cz[cx]=cu(cz[cx],cy.axisTitleMargin+M+cK*cy.offset);cU[cC]=cu(cU[cC],bE(cA.lineWidth/2)*2)},getLinePath:function(M){var cx=this.chart,cy=this.opposite,cz=this.offset,cA=this.horiz,L=this.left+(cy?this.width:0)+cz,cw=cx.chartHeight-this.bottom-(cy?this.height:0)+cz;if(cy){M*=-1}return cx.renderer.crispLine([bN,cA?this.left:L,cA?cw:this.top,bO,cA?cx.chartWidth-this.right:L,cA?cw:cx.chartHeight-this.bottom],M)},getTitlePosition:function(){var cD=this.horiz,cz=this.left,L=this.top,cB=this.len,cC=this.options.title,cx=cD?cz:L,cA=this.opposite,cy=this.offset,cE=b8(cC.style.fontSize||12),M={low:cx+(cD?0:cB),middle:cx+cB/2,high:cx+(cD?cB:0)}[cC.align],cw=(cD?L+this.height:cz)+(cD?1:-1)*(cA?-1:1)*this.axisTitleMargin+(this.side===2?cE:0);return{x:cD?M:cw+(cA?this.width:0)+cy+(cC.x||0),y:cD?cw-(cA?this.height:0)+cy:M+(cC.y||0)}},render:function(){var cz=this,cR=cz.horiz,cx=cz.reversed,cK=cz.chart,cO=cK.renderer,cB=cz.options,cJ=cz.isLog,cF=cz.isLinked,cS=cz.tickPositions,cG,cC=cz.axisTitle,cT=cz.ticks,cw=cz.minorTicks,cA=cz.alternateBands,cM=cB.stackLabels,M=cB.alternateGridColor,cU=cz.tickmarkOffset,L=cB.lineWidth,cE,cI=cK.hasRendered,cH=cI&&an(cz.oldMin)&&!isNaN(cz.oldMin),cQ=cz.hasData,cL=cz.showAxis,cP,cN=cB.labels.overflow,cD=cz.justifyLabels=cR&&cN!==false,cy;cz.labelEdge.length=0;cz.justifyToPlot=cN==="justify";I([cT,cw,cA],function(cV){var cW;for(cW in cV){cV[cW].isActive=false}});if(cQ||cF){if(cz.minorTickInterval&&!cz.categories){I(cz.getMinorTickPositions(),function(cV){if(!cw[cV]){cw[cV]=new aJ(cz,cV,"minor")}if(cH&&cw[cV].isNew){cw[cV].render(null,true)}cw[cV].render(null,false,1)})}if(cS.length){cG=cS.slice();if((cR&&cx)||(!cR&&!cx)){cG.reverse()}if(cD){cG=cG.slice(1).concat([cG[0]])}I(cG,function(cW,cV){if(cD){cV=(cV===cG.length-1)?0:cV+1}if(!cF||(cW>=cz.min&&cW<=cz.max)){if(!cT[cW]){cT[cW]=new aJ(cz,cW)}if(cH&&cT[cW].isNew){cT[cW].render(cV,true,0.1)}cT[cW].render(cV,false,1)}});if(cU&&cz.min===0){if(!cT[-1]){cT[-1]=new aJ(cz,-1,null,true)}cT[-1].render(-1)}}if(M){I(cS,function(cW,cV){if(cV%2===0&&cW<cz.max){if(!cA[cW]){cA[cW]=new aZ.PlotLineOrBand(cz)}cP=cW+cU;cy=cS[cV+1]!==k?cS[cV+1]+cU:cz.max;cA[cW].options={from:cJ?y(cP):cP,to:cJ?y(cy):cy,color:M};cA[cW].render();cA[cW].isActive=true}})}if(!cz._addedPlotLB){I((cB.plotLines||[]).concat(cB.plotBands||[]),function(cV){cz.addPlotBandOrLine(cV)});cz._addedPlotLB=true}}I([cT,cw,cA],function(cZ){var c0,cY,cX=[],cW=cv?cv.duration||500:0,cV=function(){cY=cX.length;while(cY--){if(cZ[cX[cY]]&&!cZ[cX[cY]].isActive){cZ[cX[cY]].destroy();delete cZ[cX[cY]]}}};for(c0 in cZ){if(!cZ[c0].isActive){cZ[c0].render(c0,false,0);cZ[c0].isActive=false;cX.push(c0)}}if(cZ===cA||!cK.hasRendered||!cW){cV()}else{if(cW){setTimeout(cV,cW)}}});if(L){cE=cz.getLinePath(L);if(!cz.axisLine){cz.axisLine=cO.path(cE).attr({stroke:cB.lineColor,"stroke-width":L,zIndex:7}).add(cz.axisGroup)}else{cz.axisLine.animate({d:cE})}cz.axisLine[cL?"show":"hide"]()}if(cC&&cL){cC[cC.isNew?"attr":"animate"](cz.getTitlePosition());cC.isNew=false}if(cM&&cM.enabled){cz.renderStackTotals()}cz.isDirty=false},redraw:function(){var M=this,L=M.chart,cw=L.pointer;if(cw){cw.reset(true)}M.render();I(M.plotLinesAndBands,function(cx){cx.render()});I(M.series,function(cx){cx.isDirty=true})},destroy:function(cw){var cz=this,cy=cz.stacks,L,M=cz.plotLinesAndBands,cx;if(!cw){bh(cz)}for(L in cy){bp(cy[L]);cy[L]=null}I([cz.ticks,cz.minorTicks,cz.alternateBands],function(cA){bp(cA)});cx=M.length;while(cx--){M[cx].destroy()}I(["stackTotalGroup","axisLine","axisTitle","axisGroup","cross","gridGroup","labelGroup"],function(cA){if(cz[cA]){cz[cA]=cz[cA].destroy()}});if(this.cross){this.cross.destroy()}},drawCrosshair:function(cy,L){if(!this.crosshair){return}if((an(L)||!a0(this.crosshair.snap,true))===false){this.hideCrosshair();return}var cx,M=this.crosshair,cw=M.animation,cA;if(!a0(M.snap,true)){cA=(this.horiz?cy.chartX-this.pos:this.len-cy.chartY+this.pos)}else{if(an(L)){cA=(this.chart.inverted!=this.horiz)?L.plotX:this.len-L.plotY}}if(this.isRadial){cx=this.getPlotLinePath(this.isXAxis?L.x:a0(L.stackY,L.y))}else{cx=this.getPlotLinePath(null,null,null,null,cA)}if(cx===null){this.hideCrosshair();return}if(this.cross){this.cross.attr({visibility:av})[cw?"animate":"attr"]({d:cx},cw)}else{var cz={"stroke-width":M.width||1,stroke:M.color||"#C0C0C0",zIndex:M.zIndex||2};if(M.dashStyle){cz.dashstyle=M.dashStyle}this.cross=this.chart.renderer.path(cx).attr(cz).add()}},hideCrosshair:function(){if(this.cross){this.cross.hide()}}};bD(C.prototype,r);C.prototype.getTimeTicks=function(cD,cy,cC,cI){var cJ=[],cz,cH={},cG=bS.global.useUTC,cE,cx=new Date(cy-bz),M=cD.unitRange,cB=cD.count;if(an(cy)){if(M>=bg[by]){cx.setMilliseconds(0);cx.setSeconds(M>=bg[b3]?0:cB*bE(cx.getSeconds()/cB))}if(M>=bg[b3]){cx[ay](M>=bg[Z]?0:cB*bE(cx[D]()/cB))}if(M>=bg[Z]){cx[b2](M>=bg[b5]?0:cB*bE(cx[aa]()/cB))}if(M>=bg[b5]){cx[aM](M>=bg[bx]?1:cB*bE(cx[bC]()/cB))}if(M>=bg[bx]){cx[b7](M>=bg[bu]?0:cB*bE(cx[ae]()/cB));cE=cx[ac]()}if(M>=bg[bu]){cE-=cE%cB;cx[J](cE)}if(M===bg[ch]){cx[aM](cx[bC]()-cx[aF]()+a0(cI,1))}cz=1;if(bz){cx=new Date(cx.getTime()+bz)}cE=cx[ac]();var cw=cx.getTime(),cA=cx[ae](),L=cx[bC](),cF=cG?bz:(24*3600*1000+cx.getTimezoneOffset()*60*1000)%(24*3600*1000);while(cw<cC){cJ.push(cw);if(M===bg[bu]){cw=af(cE+cz*cB,0)}else{if(M===bg[bx]){cw=af(cE,cA+cz*cB)}else{if(!cG&&(M===bg[b5]||M===bg[ch])){cw=af(cE,cA,L+cz*cB*(M===bg[b5]?1:7))}else{cw+=M*cB}}}cz++}cJ.push(cw);I(bQ(cJ,function(cK){return M<=bg[Z]&&cK%bg[b5]===cF}),function(cK){cH[cK]=b5})}cJ.info=bD(cD,{higherRanks:cH,totalRange:M*cB});return cJ};C.prototype.normalizeTimeTickInterval=function(L,cw){var cA=cw||[[ck,[1,2,5,10,20,25,50,100,200,500]],[by,[1,2,5,10,15,30]],[b3,[1,2,5,10,15,30]],[Z,[1,2,3,4,6,8,12]],[b5,[1,2]],[ch,[1,2]],[bx,[1,2,3,4,6]],[bu,null]],cC=cA[cA.length-1],M=bg[cC[0]],cx=cC[1],cz,cy;for(cy=0;cy<cA.length;cy++){cC=cA[cy];M=bg[cC[0]];cx=cC[1];if(cA[cy+1]){var cB=(M*cx[cx.length-1]+bg[cA[cy+1][0]])/2;if(L<=cB){break}}}if(M===bg[bu]&&L<5*M){cx=[1,2,5]}cz=b1(L/M,cx,cC[0]===bu?cu(n(L/M),1):1);return{unitRange:M,count:cz,unitName:cC[0]}};C.prototype.getLogTickPositions=function(cP,cH,cK,M){var cw=this,cx=cw.options,L=cw.len,cD=[];if(!M){cw._minorAutoInterval=null}if(cP>=0.5){cP=o(cP);cD=cw.getLinearTickPositions(cP,cH,cK)}else{if(cP>=0.08){var cO=bE(cH),cM,cL,cJ,cN,cy,cI,cC;if(cP>0.3){cM=[1,2,4]}else{if(cP>0.15){cM=[1,2,4,6,8]}else{cM=[1,2,3,4,5,6,7,8,9]}}for(cL=cO;cL<cK+1&&!cC;cL++){cN=cM.length;for(cJ=0;cJ<cN&&!cC;cJ++){cy=v(y(cL)*cM[cJ]);if(cy>cH&&(!M||cI<=cK)){cD.push(cI)}if(cI>cK){cC=true}cI=cy}}}else{var cF=y(cH),cG=y(cK),cB=cx[M?"minorTickInterval":"tickInterval"],cA=cB==="auto"?null:cB,cE=cx.tickPixelInterval/(M?5:1),cz=M?L/cw.tickPositions.length:L;cP=a0(cA,cw._minorAutoInterval,(cG-cF)*cE/(cz||1));cP=b1(cP,null,n(cP));cD=ar(cw.getLinearTickPositions(cP,cF,cG),v);if(!M){cw._minorAutoInterval=cP/5}}}if(!M){cw.tickInterval=cP}return cD};var cg=aZ.Tooltip=function(){this.init.apply(this,arguments)};cg.prototype={init:function(cx,M){var L=M.borderWidth,cw=M.style,cy=b8(cw.padding);this.chart=cx;this.options=M;this.crosshairs=[];this.now={x:0,y:0};this.isHidden=true;this.label=cx.renderer.label("",0,0,M.shape,null,null,M.useHTML,null,"tooltip").attr({padding:cy,fill:M.backgroundColor,"stroke-width":L,r:M.borderRadius,zIndex:8}).css(cw).css({padding:0}).add().attr({y:-9999});if(!bj){this.label.shadow(M.shadow)}this.shared=M.shared},destroy:function(){if(this.label){this.label=this.label.destroy()}clearTimeout(this.hideTimer);clearTimeout(this.tooltipTimeout)},move:function(M,cA,L,cz){var cy=this,cx=cy.now,cw=cy.options.animation!==false&&!cy.isHidden;bD(cx,{x:cw?(2*cx.x+M)/3:M,y:cw?(cx.y+cA)/2:cA,anchorX:cw?(2*cx.anchorX+L)/3:L,anchorY:cw?(cx.anchorY+cz)/2:cz});cy.label.attr(cx);if(cw&&(f(M-cx.x)>1||f(cA-cx.y)>1)){clearTimeout(this.tooltipTimeout);this.tooltipTimeout=setTimeout(function(){if(cy){cy.move(M,cA,L,cz)}},32)}},hide:function(){var M=this,L;clearTimeout(this.hideTimer);if(!this.isHidden){L=this.chart.hoverPoints;this.hideTimer=setTimeout(function(){M.label.fadeOut();M.isHidden=true},a0(this.options.hideDelay,500));if(L){I(L,function(cw){cw.setState()})}this.chart.hoverPoints=null}},getAnchor:function(cB,L){var cy,cz=this.chart,cx=cz.inverted,cA=cz.plotTop,M=0,cC=0,cw;cB=bw(cB);cy=cB[0].tooltipPos;if(this.followPointer&&L){if(L.chartX===k){L=cz.pointer.normalize(L)}cy=[L.chartX-cz.plotLeft,L.chartY-cA]}if(!cy){I(cB,function(cD){cw=cD.series.yAxis;M+=cD.plotX;cC+=(cD.plotLow?(cD.plotLow+cD.plotHigh)/2:cD.plotY)+(!cx&&cw?cw.top-cA:0)});M/=cB.length;cC/=cB.length;cy=[cx?cz.plotWidth-cC:M,this.shared&&!cx&&cB.length>1&&L?L.chartY-cA:cx?cz.plotHeight-M:cC]}return ar(cy,o)},getPosition:function(cx,cA,cG){var cz=this.chart,cw=cz.plotLeft,cC=cz.plotTop,cB=cz.plotWidth,cD=cz.plotHeight,M=a0(this.options.distance,12),L=(isNaN(cG.plotX)?0:cG.plotX),cH=cG.plotY,cF=L+cw+(cz.inverted?M:-cx-M),cE=cH-cA+cC+15,cy;if(cF<7){cF=cw+cu(L,0)+M}if((cF+cx)>(cw+cB)){cF-=(cF+cx)-(cw+cB);cE=cH-cA+cC-M;cy=true}if(cE<cC+5){cE=cC+5;if(cy&&cH>=cE&&cH<=(cE+cA)){cE=cH+cC+M}}if(cE+cA>cC+cD){cE=cu(cC,cC+cD-cA-M)}return{x:cF,y:cE}},defaultFormatter:function(cx){var L=this.points||bw(this),M=L[0].series,cw;cw=[cx.tooltipHeaderFormatter(L[0])];I(L,function(cy){M=cy.series;cw.push((M.tooltipFormatter&&M.tooltipFormatter(cy))||cy.point.tooltipFormatter(M.tooltipOptions.pointFormat))});cw.push(cx.options.footerFormat||"");return cw.join("")},refresh:function(cG,M){var cJ=this,cB=cJ.chart,cD=cJ.label,cK=cJ.options,cE,cC,cA,L={},cH,cx=[],cF=cK.formatter||cJ.defaultFormatter,cw=cB.hoverPoints,cz,cy=cJ.shared,cI;clearTimeout(this.hideTimer);cJ.followPointer=bw(cG)[0].series.tooltipOptions.followPointer;cA=cJ.getAnchor(cG,M);cE=cA[0];cC=cA[1];if(cy&&!(cG.series&&cG.series.noSharedTooltip)){cB.hoverPoints=cG;if(cw){I(cw,function(cL){cL.setState()})}I(cG,function(cL){cL.setState(a2);cx.push(cL.getLabelConfig())});L={x:cG[0].category,y:cG[0].y};L.points=cx;cG=cG[0]}else{L=cG.getLabelConfig()}cH=cF.call(L,cJ);cI=cG.series;if(cH===false){this.hide()}else{if(cJ.isHidden){bb(cD);cD.attr("opacity",1).show()}cD.attr({text:cH});cz=cK.borderColor||cG.color||cI.color||"#606060";cD.attr({stroke:cz});cJ.updatePosition({plotX:cE,plotY:cC});this.isHidden=false}bM(cB,"tooltipRefresh",{text:cH,x:cE+cB.plotLeft,y:cC+cB.plotTop,borderColor:cz})},updatePosition:function(L){var cw=this.chart,M=this.label,cx=(this.options.positioner||this.getPosition).call(this,M.width,M.height,L);this.move(o(cx.x),o(cx.y),L.plotX+cw.plotLeft,L.plotY+cw.plotTop)},tooltipHeaderFormatter:function(cD){var cz=cD.series,cw=cz.tooltipOptions,cA=cw.dateTimeLabelFormats,cy=cw.xDateFormat,L=cz.xAxis,cC=L&&L.options.type==="datetime"&&aD(cD.key),cx=cw.headerFormat,cB=L&&L.closestPointRange,M;if(cC&&!cy){if(cB){for(M in bg){if(bg[M]>=cB||(bg[M]<=bg[b5]&&cD.key%bg[M]>0)){cy=cA[M];break}}}else{cy=cA.day}cy=cy||cA.year}if(cC&&cy){cx=cx.replace("{point.key}","{point.key:"+cy+"}")}return g(cx,{point:cD,series:cz})}};var aC;H=bW.documentElement.ontouchstart!==k;var aX=aZ.Pointer=function(M,L){this.init(M,L)};aX.prototype={init:function(cx,cw){var cB=cw.chart,cA=cB.events,L=bj?"":cB.zoomType,M=cx.inverted,cz,cy;this.options=cw;this.chart=cx;this.zoomX=cz=/x/.test(L);this.zoomY=cy=/y/.test(L);this.zoomHor=(cz&&!M)||(cy&&M);this.zoomVert=(cy&&!M)||(cz&&M);this.runChartClick=cA&&!!cA.click;this.pinchDown=[];this.lastValidTouch={};if(aZ.Tooltip&&cw.tooltip.enabled){cx.tooltip=new cg(cx,cw.tooltip)}this.setDOMEvents()},normalize:function(cx,cw){var M,cy,L;cx=cx||bf.event;cx=U(cx);if(!cx.target){cx.target=cx.srcElement}L=cx.touches?cx.touches.item(0):cx;if(!cw){this.chartPosition=cw=cd(this.chart.container)}if(L.pageX===k){M=cu(cx.x,cx.clientX-cw.left);cy=cx.y}else{M=L.pageX-cw.left;cy=L.pageY-cw.top}return bD(cx,{chartX:o(M),chartY:o(cy)})},getCoordinates:function(L){var M={xAxis:[],yAxis:[]};I(this.chart.axes,function(cw){M[cw.isXAxis?"xAxis":"yAxis"].push({axis:cw,value:cw.toValue(L[cw.horiz?"chartX":"chartY"])})});return M},getIndex:function(M){var L=this.chart;return L.inverted?L.plotHeight+L.plotTop-M.chartY:M.chartX-L.plotLeft},runPointActions:function(cC){var L=this,cD=L.chart,cA=cD.series,cH=cD.tooltip,cF,cG,M=cD.hoverPoint,cE=cD.hoverSeries,cz,cx,cw=cD.chartWidth,cB=L.getIndex(cC),cy;if(cH&&L.options.tooltip.shared&&!(cE&&cE.noSharedTooltip)){cG=[];cz=cA.length;for(cx=0;cx<cz;cx++){if(cA[cx].visible&&cA[cx].options.enableMouseTracking!==false&&!cA[cx].noSharedTooltip&&cA[cx].singularTooltips!==true&&cA[cx].tooltipPoints.length){cF=cA[cx].tooltipPoints[cB];if(cF&&cF.series){cF._dist=f(cB-cF.clientX);cw=aw(cw,cF._dist);cG.push(cF)}}}cz=cG.length;while(cz--){if(cG[cz]._dist>cw){cG.splice(cz,1)}}if(cG.length&&(cG[0].clientX!==L.hoverX)){cH.refresh(cG,cC);L.hoverX=cG[0].clientX}}if(cE&&cE.tracker&&(!cH||!cH.followPointer)){cF=cE.tooltipPoints[cB];if(cF&&cF!==M){cF.onMouseOver(cC)}}else{if(cH&&cH.followPointer&&!cH.isHidden){cy=cH.getAnchor([{}],cC);cH.updatePosition({plotX:cy[0],plotY:cy[1]})}}if(cH&&!L._onDocumentMouseMove){L._onDocumentMouseMove=function(cI){if(an(aC)){aO[aC].pointer.onDocumentMouseMove(cI)}};z(bW,"mousemove",L._onDocumentMouseMove)}I(cD.axes,function(cI){cI.drawCrosshair(cC,a0(cF,M))})},reset:function(cA){var cz=this,cx=cz.chart,M=cx.hoverSeries,L=cx.hoverPoint,cy=cx.tooltip,cw=cy&&cy.shared?cx.hoverPoints:L;cA=cA&&cy&&cw;if(cA&&bw(cw)[0].plotX===k){cA=false}if(cA){cy.refresh(cw);if(L){L.setState(L.state,true)}}else{if(L){L.onMouseOut()}if(M){M.onMouseOut()}if(cy){cy.hide()}if(cz._onDocumentMouseMove){bh(bW,"mousemove",cz._onDocumentMouseMove);cz._onDocumentMouseMove=null}I(cx.axes,function(cB){cB.hideCrosshair()});cz.hoverX=null}},scaleGroups:function(cw,M){var L=this.chart,cx;I(L.series,function(cy){cx=cw||cy.getPlotBox();if(cy.xAxis&&cy.xAxis.zoomEnabled){cy.group.attr(cx);if(cy.markerGroup){cy.markerGroup.attr(cx);cy.markerGroup.clip(M?L.clipRect:null)}if(cy.dataLabelsGroup){cy.dataLabelsGroup.attr(cx)}}});L.clipRect.attr(M||L.clipBox)},dragStart:function(M){var L=this.chart;L.mouseIsDown=M.type;L.cancelClick=false;L.mouseDownX=this.mouseDownX=M.chartX;L.mouseDownY=this.mouseDownY=M.chartY},drag:function(cB){var cC=this.chart,cy=cC.options.chart,cD=cB.chartX,cA=cB.chartY,cw=this.zoomHor,cH=this.zoomVert,cx=cC.plotLeft,cG=cC.plotTop,cF=cC.plotWidth,cE=cC.plotHeight,cz,cI,M=this.mouseDownX,L=this.mouseDownY;if(cD<cx){cD=cx}else{if(cD>cx+cF){cD=cx+cF}}if(cA<cG){cA=cG}else{if(cA>cG+cE){cA=cG+cE}}this.hasDragged=Math.sqrt(Math.pow(M-cD,2)+Math.pow(L-cA,2));if(this.hasDragged>10){cz=cC.isInsidePlot(M-cx,L-cG);if(cC.hasCartesianSeries&&(this.zoomX||this.zoomY)&&cz){if(!this.selectionMarker){this.selectionMarker=cC.renderer.rect(cx,cG,cw?1:cF,cH?1:cE,0).attr({fill:cy.selectionMarkerFill||"rgba(69,114,167,0.25)",zIndex:7}).add()}}if(this.selectionMarker&&cw){cI=cD-M;this.selectionMarker.attr({width:f(cI),x:(cI>0?0:cI)+M})}if(this.selectionMarker&&cH){cI=cA-L;this.selectionMarker.attr({height:f(cI),y:(cI>0?0:cI)+L})}if(cz&&!this.selectionMarker&&cy.panning){cC.pan(cB,cy.panning)}}},drop:function(cB){var cy=this.chart,cw=this.hasPinched;if(this.selectionMarker){var cz={xAxis:[],yAxis:[],originalEvent:cB.originalEvent||cB},M=this.selectionMarker,cA=M.x,cx=M.y,L;if(this.hasDragged||cw){I(cy.axes,function(cD){if(cD.zoomEnabled){var cF=cD.horiz,cC=cD.toValue((cF?cA:cx)),cE=cD.toValue((cF?cA+M.width:cx+M.height));if(!isNaN(cC)&&!isNaN(cE)){cz[cD.coll].push({axis:cD,min:aw(cC,cE),max:cu(cC,cE)});L=true}}});if(L){bM(cy,"selection",cz,function(cC){cy.zoom(bD(cC,cw?{animation:false}:null))})}}this.selectionMarker=this.selectionMarker.destroy();if(cw){this.scaleGroups()}}if(cy){cp(cy.container,{cursor:cy._cursor});cy.cancelClick=this.hasDragged>10;cy.mouseIsDown=this.hasDragged=this.hasPinched=false;this.pinchDown=[]}},onContainerMouseDown:function(L){L=this.normalize(L);if(L.preventDefault){L.preventDefault()}this.dragStart(L)},onDocumentMouseUp:function(L){if(an(aC)){aO[aC].pointer.drop(L)}},onDocumentMouseMove:function(cx){var cw=this.chart,L=this.chartPosition,M=cw.hoverSeries;cx=this.normalize(cx,L);if(L&&M&&!this.inClass(cx.target,"highcharts-tracker")&&!cw.isInsidePlot(cx.chartX-cw.plotLeft,cx.chartY-cw.plotTop)){this.reset()}},onContainerMouseLeave:function(){var L=aO[aC];if(L){L.pointer.reset();L.pointer.chartPosition=null}aC=null},onContainerMouseMove:function(M){var L=this.chart;aC=L.index;M=this.normalize(M);if(L.mouseIsDown==="mousedown"){this.drag(M)}if(L.isInsidePlot(M.chartX-L.plotLeft,M.chartY-L.plotTop)||M.synthetic){this.runPointActions(M);if(!M.synthetic&&L.options&&L.options.events&&L.options.events.mouseMove){L.options.events.mouseMove(M,L)}}},inClass:function(L,cw){var M;while(L){M=V(L,"class");if(M){if(M.indexOf(cw)!==-1){return true}else{if(M.indexOf(bk+"container")!==-1){return false}}}L=L.parentNode}},onTrackerMouseOut:function(cx){var M=this.chart.hoverSeries,L=cx.relatedTarget||cx.toElement,cw=L&&L.point&&L.point.series;if(M&&!M.options.stickyTracking&&!this.inClass(L,bk+"tooltip")&&cw!==M){M.onMouseOut()}},onContainerClick:function(cy){var cA=this.chart,M=cA.hoverPoint,cw=cA.plotLeft,cB=cA.plotTop,cx=cA.inverted,cz,L,cC;cy=this.normalize(cy);cy.cancelBubble=true;if(!cA.cancelClick){if(M&&this.inClass(cy.target,bk+"tracker")){cz=this.chartPosition;L=M.plotX;cC=M.plotY;bD(M,{pageX:cz.left+cw+(cx?cA.plotWidth-cC:L),pageY:cz.top+cB+(cx?cA.plotHeight-L:cC)});bM(M.series,"click",bD(cy,{point:M}));if(cA.hoverPoint){M.firePointEvent("click",cy)}}else{bD(cy,this.getCoordinates(cy));if(cA.isInsidePlot(cy.chartX-cw,cy.chartY-cB)){bM(cA,"click",cy)}}}},setDOMEvents:function(){var M=this,L=M.chart.container;L.onmousedown=function(cw){M.onContainerMouseDown(cw)};L.onmousemove=function(cw){M.onContainerMouseMove(cw)};L.onclick=function(cw){M.onContainerClick(cw)};z(L,"mouseleave",M.onContainerMouseLeave);z(bW,"mouseup",M.onDocumentMouseUp);if(H){L.ontouchstart=function(cw){M.onContainerTouchStart(cw)};L.ontouchmove=function(cw){M.onContainerTouchMove(cw)};z(bW,"touchend",M.onDocumentTouchEnd)}},destroy:function(){var L;bh(this.chart.container,"mouseleave",this.onContainerMouseLeave);bh(bW,"mouseup",this.onDocumentMouseUp);bh(bW,"touchend",this.onDocumentTouchEnd);clearInterval(this.tooltipTimeout);for(L in this){this[L]=null}}};bD(aZ.Pointer.prototype,{pinchTranslate:function(cA,cB,M,cz,cw,cx,cy,L){if(cA){this.pinchTranslateDirection(true,M,cz,cw,cx,cy,L)}if(cB){this.pinchTranslateDirection(false,M,cz,cw,cx,cy,L)}},pinchTranslateDirection:function(cV,cR,cM,cL,cx,cT,cP,cS){var cO=this.chart,cB=cV?"x":"y",cw=cV?"X":"Y",cU="chart"+cw,cD=cV?"width":"height",M=cO["plot"+(cV?"Left":"Top")],cF,cC,cI,cW=cS||1,cN=cO.inverted,cE=cO.bounds[cV?"h":"v"],cA=cR.length===1,cz=cR[0][cU],cK=cM[0][cU],cG=!cA&&cR[1][cU],cQ=!cA&&cM[1][cU],cy,L,cH,cJ=function(){if(!cA&&f(cz-cG)>20){cW=cS||f(cK-cQ)/f(cz-cG)}cI=((M-cK)/cW)+cz;cF=cO["plot"+(cV?"Width":"Height")]/cW};cJ();cC=cI;if(cC<cE.min){cC=cE.min;cy=true}else{if(cC+cF>cE.max){cC=cE.max-cF;cy=true}}if(cy){cK-=0.8*(cK-cP[cB][0]);if(!cA){cQ-=0.8*(cQ-cP[cB][1])}cJ()}else{cP[cB]=[cK,cQ]}if(!cN){cT[cB]=cI-M;cT[cD]=cF}cH=cN?(cV?"scaleY":"scaleX"):"scale"+cw;L=cN?1/cW:cW;cx[cD]=cF;cx[cB]=cC;cL[cH]=cW;cL["translate"+cw]=(L*M)+(cK-(L*cz))},pinch:function(cD){var cI=this,cE=cI.chart,cH=cI.pinchDown,cC=cE.tooltip&&cE.tooltip.options.followTouchMove,cA=cD.touches,M=cA.length,cw=cI.lastValidTouch,L=cI.zoomHor||cI.pinchHor,cG=cI.zoomVert||cI.pinchVert,cB=L||cG,cF=cI.selectionMarker,cx={},cz=M===1&&((cI.inClass(cD.target,bk+"tracker")&&cE.runTrackerClick)||cE.runChartClick),cy={};if((cB||cC)&&!cz){cD.preventDefault()}ar(cA,function(cJ){return cI.normalize(cJ)});if(cD.type==="touchstart"){I(cA,function(cK,cJ){cH[cJ]={chartX:cK.chartX,chartY:cK.chartY}});cw.x=[cH[0].chartX,cH[1]&&cH[1].chartX];cw.y=[cH[0].chartY,cH[1]&&cH[1].chartY];I(cE.axes,function(cO){if(cO.zoomEnabled){var cP=cE.bounds[cO.horiz?"h":"v"],cL=cO.minPixelPadding,cM=cO.toPixels(cO.dataMin),cJ=cO.toPixels(cO.dataMax),cN=aw(cM,cJ),cK=cu(cM,cJ);cP.min=aw(cO.pos,cN-cL);cP.max=cu(cO.pos+cO.len,cK+cL)}})}else{if(cH.length){if(!cF){cI.selectionMarker=cF=bD({destroy:j},cE.plotBox)}cI.pinchTranslate(L,cG,cH,cA,cx,cF,cy,cw);cI.hasPinched=cB;cI.scaleGroups(cx,cy);if(!cB&&cC&&M===1){this.runPointActions(cI.normalize(cD))}}}},onContainerTouchStart:function(M){var L=this.chart;aC=L.index;if(M.touches.length===1){M=this.normalize(M);if(L.isInsidePlot(M.chartX-L.plotLeft,M.chartY-L.plotTop)){this.runPointActions(M);this.pinch(M)}else{this.reset()}}else{if(M.touches.length===2){this.pinch(M)}}},onContainerTouchMove:function(L){if(L.touches.length===1||L.touches.length===2){this.pinch(L)}},onDocumentTouchEnd:function(L){if(an(aC)){aO[aC].pointer.drop(L)}}});if(bf.PointerEvent||bf.MSPointerEvent){var e={},bH=!!bf.PointerEvent,a4=function(){var M,L=[];L.item=function(cw){return this[cw]};for(M in e){if(e.hasOwnProperty(M)){L.push({pageX:e[M].pageX,pageY:e[M].pageY,target:e[M].target})}}return L},a5=function(cw,cy,L,cx){var M;cw=cw.originalEvent||cw;if((cw.pointerType==="touch"||cw.pointerType===cw.MSPOINTER_TYPE_TOUCH)&&aO[aC]){cx(cw);M=aO[aC].pointer;M[cy]({type:L,target:cw.currentTarget,preventDefault:j,touches:a4()})}};bD(aX.prototype,{onContainerPointerDown:function(L){a5(L,"onContainerTouchStart","touchstart",function(M){e[M.pointerId]={pageX:M.pageX,pageY:M.pageY,target:M.currentTarget}})},onContainerPointerMove:function(L){a5(L,"onContainerTouchMove","touchmove",function(M){e[M.pointerId]={pageX:M.pageX,pageY:M.pageY};if(!e[M.pointerId].target){e[M.pointerId].target=M.currentTarget}})},onDocumentPointerUp:function(L){a5(L,"onContainerTouchEnd","touchend",function(M){delete e[M.pointerId]})},batchMSEvents:function(L){L(this.chart.container,bH?"pointerdown":"MSPointerDown",this.onContainerPointerDown);L(this.chart.container,bH?"pointermove":"MSPointerMove",this.onContainerPointerMove);L(bW,bH?"pointerup":"MSPointerUp",this.onDocumentPointerUp)}});bc(aX.prototype,"init",function(cw,M,L){cp(M.container,{"-ms-touch-action":B,"touch-action":B});cw.call(this,M,L)});bc(aX.prototype,"setDOMEvents",function(L){L.apply(this);this.batchMSEvents(z)});bc(aX.prototype,"destroy",function(L){this.batchMSEvents(bh);L.call(this)})}var bP=aZ.Legend=function(M,L){this.init(M,L)};bP.prototype={init:function(cw,L){var M=this,cx=L.itemStyle,cy=a0(L.padding,8),cz=L.itemMarginTop||0;this.options=L;if(!L.enabled){return}M.baseline=b8(cx.fontSize)+3+cz;M.itemStyle=cx;M.itemHiddenStyle=aY(cx,L.itemHiddenStyle);M.itemMarginTop=cz;M.padding=cy;M.initialItemX=cy;M.initialItemY=cy-5;M.maxItemWidth=0;M.chart=cw;M.itemHeight=0;M.lastLineHeight=0;M.symbolWidth=a0(L.symbolWidth,16);M.pages=[];M.render();z(M.chart,"endResize",function(){M.positionCheckboxes()})},colorizeItem:function(cG,cx){var cB=this,cH=cB.options,cz=cG.legendItem,cA=cG.legendLine,cw=cG.legendSymbol,cE=cB.itemHiddenStyle.color,cD=cx?cH.itemStyle.color:cE,cy=cx?(cG.legendColor||cG.color||"#CCC"):cE,L=cG.options&&cG.options.marker,cF={stroke:cy,fill:cy},cC,M;if(cz){cz.css({fill:cD,color:cD})}if(cA){cA.attr({stroke:cy})}if(cw){if(L&&cw.isMarker){L=cG.convertAttribs(L);for(cC in L){M=L[cC];if(M!==k){cF[cC]=M}}}cw.attr(cF)}},positionItem:function(cB){var cz=this,cC=cz.options,cA=cC.symbolPadding,L=!cC.rtl,M=cB._legendItemPos,cy=M[0],cx=M[1],cw=cB.checkbox;if(cB.legendGroup){cB.legendGroup.translate(L?cy:cz.legendWidth-cy-2*cA-4,cx)}if(cw){cw.x=cy;cw.y=cx}},destroyItem:function(L){var M=L.checkbox;I(["legendItem","legendLine","legendSymbol","legendGroup"],function(cw){if(L[cw]){L[cw]=L[cw].destroy()}});if(M){ca(L.checkbox)}},destroy:function(){var L=this,cw=L.group,M=L.box;if(M){L.box=M.destroy()}if(cw){L.group=cw.destroy()}},positionCheckboxes:function(L){var cx=this.group.alignAttr,cw,M=this.clipHeight||this.legendHeight;if(cx){cw=cx.translateY;I(this.allItems,function(cy){var cz=cy.checkbox,cA;if(cz){cA=(cw+cz.y+(L||0)+3);cp(cz,{left:(cx.translateX+cy.legendItemWidth+cz.x-20)+ab,top:cA+ab,display:cA>cw-6&&cA<cw+M-6?"":B})}})}},renderTitle:function(){var L=this.options,cx=this.padding,cw=L.title,cy=0,M;if(cw.text){if(!this.title){this.title=this.chart.renderer.label(cw.text,cx-3,cx-4,null,null,null,null,null,"legend-title").attr({zIndex:1}).css(cw.style).add(this.group)}M=this.title.getBBox();cy=M.height;this.offsetWidth=M.width;this.contentGroup.attr({translateY:cy})}this.titleHeight=cy},renderItem:function(cP){var M=this,cI=M.chart,cJ=cI.renderer,cx=M.options,cQ=cx.layout==="horizontal",cR=M.symbolWidth,L=cx.symbolPadding,cC=M.itemStyle,cw=M.itemHiddenStyle,cH=M.padding,cz=cQ?a0(cx.itemDistance,8):0,cN=!cx.rtl,cL,cF=cx.width,cB=cx.itemMarginBottom||0,cO=M.itemMarginTop,cM=M.initialItemX,cA,cy,cG=cP.legendItem,cE=cP.series&&cP.series.drawLegendSymbol?cP.series:cP,cD=cE.options,cS=M.createCheckboxForItem&&cD&&cD.showCheckbox,cK=cx.useHTML;if(!cG){cP.legendGroup=cJ.g("legend-item").attr({zIndex:1}).add(M.scrollGroup);cE.drawLegendSymbol(M,cP);cP.legendItem=cG=cJ.text(cx.labelFormat?g(cx.labelFormat,cP):cx.labelFormatter.call(cP),cN?cR+L:-L,M.baseline,cK).css(aY(cP.visible?cC:cw)).attr({align:cN?"left":"right",zIndex:2}).add(cP.legendGroup);if(M.setItemEvents){M.setItemEvents(cP,cG,cK,cC,cw)}M.colorizeItem(cP,cP.visible);if(cS){M.createCheckboxForItem(cP)}}cA=cG.getBBox();cy=cP.legendItemWidth=cx.itemWidth||cP.legendItemWidth||cR+L+cA.width+cz+(cS?20:0);M.itemHeight=cL=o(cP.legendItemHeight||cA.height);if(cQ&&M.itemX-cM+cy>(cF||(cI.chartWidth-2*cH-cM-cx.x))){M.itemX=cM;M.itemY+=cO+M.lastLineHeight+cB;M.lastLineHeight=0}M.maxItemWidth=cu(M.maxItemWidth,cy);M.lastItemY=cO+M.itemY+cB;M.lastLineHeight=cu(cL,M.lastLineHeight);cP._legendItemPos=[M.itemX,M.itemY];if(cQ){M.itemX+=cy}else{M.itemY+=cO+cL+cB;M.lastLineHeight=cL}M.offsetWidth=cF||cu((cQ?M.itemX-cM-cz:cy)+cH,M.offsetWidth)},getAllItems:function(){var L=[];I(this.chart.series,function(cw){var M=cw.options;if(!a0(M.showInLegend,!an(M.linkedTo)?k:false,true)){return}L=L.concat(cw.legendItems||(M.legendType==="point"?cw.data:cw))});return L},render:function(){var cD=this,cA=cD.chart,cz=cA.renderer,cx=cD.group,cB,cy,cF,cE,cw=cD.box,cG=cD.options,cC=cD.padding,L=cG.borderWidth,M=cG.backgroundColor;cD.itemX=cD.initialItemX;cD.itemY=cD.initialItemY;cD.offsetWidth=0;cD.lastItemY=0;if(!cx){cD.group=cx=cz.g("legend").attr({zIndex:7}).add();cD.contentGroup=cz.g().attr({zIndex:1}).add(cx);cD.scrollGroup=cz.g().add(cD.contentGroup)}cD.renderTitle();cB=cD.getAllItems();aQ(cB,function(cI,cH){return((cI.options&&cI.options.legendIndex)||0)-((cH.options&&cH.options.legendIndex)||0)});if(cG.reversed){cB.reverse()}cD.allItems=cB;cD.display=cy=!!cB.length;I(cB,function(cH){cD.renderItem(cH)});cF=cG.width||cD.offsetWidth;cE=cD.lastItemY+cD.lastLineHeight+cD.titleHeight;cE=cD.handleOverflow(cE);if(L||M){cF+=cC;cE+=cC;if(!cw){cD.box=cw=cz.rect(0,0,cF,cE,cG.borderRadius,L||0).attr({stroke:cG.borderColor,"stroke-width":L||0,fill:M||B}).add(cx).shadow(cG.shadow);cw.isNew=true}else{if(cF>0&&cE>0){cw[cw.isNew?"attr":"animate"](cw.crisp({width:cF,height:cE}));cw.isNew=false}}cw[cy?"show":"hide"]()}cD.legendWidth=cF;cD.legendHeight=cE;I(cB,function(cH){cD.positionItem(cH)});if(cy){cx.align(bD({width:cF,height:cE},cG),true,"spacingBox")}if(!cA.isResizing){this.positionCheckboxes()}},handleOverflow:function(cy){var L=this,cE=this.chart,cH=cE.renderer,cw=this.options,cB=cw.y,M=cw.verticalAlign==="top",cL=cE.spacingBox.height+(M?-cB:cB)-this.padding,cG=cw.maxHeight,cx,cI=this.clipRect,cJ=cw.navigation,cK=a0(cJ.animation,true),cF=cJ.arrowSize||12,cA=this.nav,cC=this.pages,cz,cD=this.allItems;if(cw.layout==="horizontal"){cL/=2}if(cG){cL=aw(cL,cG)}cC.length=0;if(cy>cL&&!cw.useHTML){this.clipHeight=cx=cL-20-this.titleHeight-this.padding;this.currentPage=a0(this.currentPage,1);this.fullHeight=cy;I(cD,function(cP,cN){var cQ=cP._legendItemPos[1],cO=o(cP.legendItem.getBBox().height),cM=cC.length;if(!cM||(cQ-cC[cM-1]>cx&&(cz||cQ)!==cC[cM-1])){cC.push(cz||cQ);cM++}if(cN===cD.length-1&&cQ+cO-cC[cM-1]>cx){cC.push(cQ)}if(cQ!==cz){cz=cQ}});if(!cI){cI=L.clipRect=cH.clipRect(0,this.padding,9999,0);L.contentGroup.clip(cI)}cI.attr({height:cx});if(!cA){this.nav=cA=cH.g().attr({zIndex:1}).add(this.group);this.up=cH.symbol("triangle",0,0,cF,cF).on("click",function(){L.scroll(-1,cK)}).add(cA);this.pager=cH.text("",15,10).css(cJ.style).add(cA);this.down=cH.symbol("triangle-down",0,0,cF,cF).on("click",function(){L.scroll(1,cK)}).add(cA)}L.scroll(0);cy=cL}else{if(cA){cI.attr({height:cE.chartHeight});cA.hide();this.scrollGroup.attr({translateY:1});this.clipHeight=0}}return cy},scroll:function(cz,cx){var L=this.pages,cw=L.length,cC=this.currentPage+cz,cy=this.clipHeight,cD=this.options.navigation,cE=cD.activeColor,cB=cD.inactiveColor,M=this.pager,cF=this.padding,cA;if(cC>cw){cC=cw}if(cC>0){if(cx!==k){cq(cx,this.chart)}this.nav.attr({translateX:cF,translateY:cy+this.padding+7+this.titleHeight,visibility:av});this.up.attr({fill:cC===1?cB:cE}).css({cursor:cC===1?"default":"pointer"});M.attr({text:cC+"/"+cw});this.down.attr({x:18+this.pager.getBBox().width,fill:cC===cw?cB:cE}).css({cursor:cC===cw?"default":"pointer"});cA=-L[cC-1]+this.initialItemY;this.scrollGroup.animate({translateY:cA});this.currentPage=cC;this.positionCheckboxes(cA)}}};var G=aZ.LegendSymbolMixin={drawRectangle:function(M,cw){var L=M.options.symbolHeight||12;cw.legendSymbol=this.chart.renderer.rect(0,M.baseline-5-(L/2),M.symbolWidth,L,a0(M.options.symbolRadius,2)).attr({zIndex:3}).add(cw.legendGroup)},drawLineMarker:function(cC){var cE=this.options,L=cE.marker,cy,cD=cC.options,M,cx=cC.symbolWidth,cB=this.chart.renderer,cw=this.legendGroup,cA=cC.baseline-o(cB.fontMetrics(cD.itemStyle.fontSize).b*0.3),cz;if(cE.lineWidth){cz={"stroke-width":cE.lineWidth};if(cE.dashStyle){cz.dashstyle=cE.dashStyle}this.legendLine=cB.path([bN,0,cA,bO,cx,cA]).attr(cz).add(cw)}if(L&&L.enabled){cy=L.radius;this.legendSymbol=M=cB.symbol(this.symbol,(cx/2)-cy,cA-cy,2*cy,2*cy).add(cw);M.isMarker=true}}};if(/Trident\/7\.0/.test(u)||bG){bc(bP.prototype,"positionItem",function(cw,M){var L=this,cx=function(){if(M._legendItemPos){cw.call(L,M)}};if(L.chart.renderer.forExport){cx()}else{setTimeout(cx)}})}function bB(){this.init.apply(this,arguments)}bB.prototype={init:function(cA,cB){var M,L=cA.series;cA.series=null;M=aY(bS,cA);M.series=cA.series=L;this.userOptions=cA;var cz=M.chart;this.margin=this.splashArray("margin",cz);this.spacing=this.splashArray("spacing",cz);var cy=cz.events;this.bounds={h:{},v:{}};this.callback=cB;this.isResizing=0;this.options=M;this.axes=[];this.series=[];this.hasCartesianSeries=cz.showAxes;var cx=this,cw;cx.index=aO.length;aO.push(cx);if(cz.reflow!==false){z(cx,"load",function(){cx.initReflow()})}if(cy){for(cw in cy){z(cx,cw,cy[cw])}}cx.xAxis=[];cx.yAxis=[];cx.animation=bj?false:a0(cz.animation,true);cx.pointCount=0;cx.counters=new R();cx.firstRender()},initSeries:function(L){var cx=this,cz=cx.options.chart,cw=L.type||cz.type||cz.defaultSeriesType,M,cy=a[cw];if(!cy){b9(17,true)}M=new cy();M.init(this,L);return M},isInsidePlot:function(cx,cw,M){var L=M?cw:cx,cy=M?cx:cw;return L>=0&&L<=this.plotWidth&&cy>=0&&cy<=this.plotHeight},adjustTickAmounts:function(){if(this.options.chart.alignTicks!==false){I(this.axes,function(L){L.adjustTickAmount()})}this.maxTicks=null},redraw:function(cx){var cG=this,cF=cG.axes,cA=cG.series,L=cG.pointer,cJ=cG.legend,M=cG.isDirtyLegend,cC,cH,cz=cG.isDirtyBox,cw=cA.length,cy=cw,cB,cE=cG.renderer,cI=cE.isHidden(),cD=[];cq(cx,cG);if(cI){cG.cloneRenderTo()}cG.layOutTitles();while(cy--){cB=cA[cy];if(cB.options.stacking){cC=true;if(cB.isDirty){cH=true;break}}}if(cH){cy=cw;while(cy--){cB=cA[cy];if(cB.options.stacking){cB.isDirty=true}}}I(cA,function(cK){if(cK.isDirty){if(cK.options.legendType==="point"){M=true}}});if(M&&cJ.options.enabled){cJ.render();cG.isDirtyLegend=false}if(cC){cG.getStacks()}if(cG.hasCartesianSeries){if(!cG.isResizing){cG.maxTicks=null;I(cF,function(cK){cK.setScale()})}cG.adjustTickAmounts();cG.getMargins();I(cF,function(cK){if(cK.isDirty){cz=true}});I(cF,function(cK){if(cK.isDirtyExtremes){cK.isDirtyExtremes=false;cD.push(function(){bM(cK,"afterSetExtremes",bD(cK.eventArgs,cK.getExtremes()));delete cK.eventArgs})}if(cz||cC){cK.redraw()}})}if(cz){cG.drawChartBox()}I(cA,function(cK){if(cK.isDirty&&cK.visible&&(!cK.isCartesian||cK.xAxis)){cK.redraw()}});if(L){L.reset(true)}cE.draw();bM(cG,"redraw");if(cI){cG.cloneRenderTo(true)}I(cD,function(cK){cK.call()})},get:function(cA){var cy=this,cz=cy.axes,cw=cy.series;var M,L,cx;for(M=0;M<cz.length;M++){if(cz[M].options.id===cA){return cz[M]}}for(M=0;M<cw.length;M++){if(cw[M].options.id===cA){return cw[M]}}for(M=0;M<cw.length;M++){cx=cw[M].points||[];for(L=0;L<cx.length;L++){if(cx[L].id===cA){return cx[L]}}}return null},getAxes:function(){var cy=this,cw=this.options,L=cw.xAxis=bw(cw.xAxis||{}),cz=cw.yAxis=bw(cw.yAxis||{}),M,cx;I(L,function(cB,cA){cB.index=cA;cB.isX=true});I(cz,function(cB,cA){cB.index=cA});M=L.concat(cz);I(M,function(cA){cx=new C(cy,cA)});cy.adjustTickAmounts()},getSelectedPoints:function(){var L=[];I(this.series,function(M){L=L.concat(bQ(M.points||[],function(cw){return cw.selected}))});return L},getSelectedSeries:function(){return bQ(this.series,function(L){return L.selected})},getStacks:function(){var L=this;I(L.yAxis,function(M){if(M.stacks&&M.hasVisibleSeries){M.oldStacks=M.stacks}});I(L.series,function(M){if(M.options.stacking&&(M.visible===true||L.options.chart.ignoreHiddenSeries===false)){M.stackKey=M.type+a0(M.options.stack,"")}})},setTitle:function(cy,L,cA){var cx=this,M=cx.options,cw,cz;cw=M.title=aY(M.title,cy);cz=M.subtitle=aY(M.subtitle,L);I([["title",cy,cw],["subtitle",L,cz]],function(cB){var cC=cB[0],cF=cx[cC],cE=cB[1],cD=cB[2];if(cF&&cE){cx[cC]=cF=cF.destroy()}if(cD&&cD.text&&!cF){cx[cC]=cx.renderer.text(cD.text,0,0,cD.useHTML).attr({align:cD.align,"class":bk+cC,zIndex:cD.zIndex||4}).css(cD.style).add()}});cx.layOutTitles(cA)},layOutTitles:function(cz){var cA=0,cw=this.title,cx=this.subtitle,cC=this.options,cB=cC.title,cy=cC.subtitle,L,M=this.spacingBox.width-44;if(cw){cw.css({width:(cB.width||M)+ab}).align(bD({y:15},cB),false,"spacingBox");if(!cB.floating&&!cB.verticalAlign){cA=cw.getBBox().height;if(cA>=18&&cA<=25){cA=15}}}if(cx){cx.css({width:(cy.width||M)+ab}).align(bD({y:cA+cB.margin},cy),false,"spacingBox");if(!cy.floating&&!cy.verticalAlign){cA=aK(cA+cx.getBBox().height)}}L=this.titleOffset!==cA;this.titleOffset=cA;if(!this.isDirtyBox&&L){this.isDirtyBox=L;if(this.hasRendered&&a0(cz,true)&&this.isDirtyBox){this.redraw()}}},getChartSize:function(){var M=this,cy=M.options.chart,cw=cy.width,L=cy.height,cx=M.renderToClone||M.renderTo;if(!an(cw)){M.containerWidth=aR(cx,"width")}if(!an(L)){M.containerHeight=aR(cx,"height")}M.chartWidth=cu(0,cw||M.containerWidth||600);M.chartHeight=cu(0,a0(L,M.containerHeight>19?M.containerHeight:400))},cloneRenderTo:function(M){var cw=this.renderToClone,L=this.container;if(M){if(cw){this.renderTo.appendChild(L);ca(cw);delete this.renderToClone}}else{if(L&&L.parentNode===this.renderTo){this.renderTo.removeChild(L)}this.renderToClone=cw=this.renderTo.cloneNode(0);cp(cw,{position:ax,top:"-9999px",display:"block"});if(cw.style.setProperty){cw.style.setProperty("display","block","important")}bW.body.appendChild(cw);if(L){cw.appendChild(L)}}},getContainer:function(){var cB=this,L,cA=cB.options.chart,cz,M,cC,cw="data-highcharts-chart",cx,cy;cB.renderTo=cC=cA.renderTo;cy=bk+bo++;if(bK(cC)){cB.renderTo=cC=bW.getElementById(cC)}if(!cC){b9(13,true)}cx=b8(V(cC,cw));if(!isNaN(cx)&&aO[cx]&&aO[cx].hasRendered){aO[cx].destroy()}V(cC,cw,cB.index);cC.innerHTML="";if(!cA.skipClone&&!cC.offsetWidth){cB.cloneRenderTo()}cB.getChartSize();cz=cB.chartWidth;M=cB.chartHeight;cB.container=L=bF(P,{className:bk+"container"+(cA.className?" "+cA.className:""),id:cy},bD({position:O,overflow:ap,width:cz+ab,height:M+ab,textAlign:"left",lineHeight:"normal",zIndex:0,"-webkit-tap-highlight-color":"rgba(0,0,0,0)"},cA.style),cB.renderToClone||cC);cB._cursor=L.style.cursor;cB.renderer=cA.forExport?new d(L,cz,M,cA.style,true):new cf(L,cz,M,cA.style);if(bj){cB.renderer.create(cB,L,cz,M)}},getMargins:function(){var cz=this,cA=cz.spacing,cC,cD=cz.legend,cw=cz.margin,cE=cz.options.legend,M=a0(cE.margin,10),cB=cE.x,cy=cE.y,cx=cE.align,L=cE.verticalAlign,cF=cz.titleOffset;cz.resetMargins();cC=cz.axisOffset;if(cF&&!an(cw[0])){cz.plotTop=cu(cz.plotTop,cF+cz.options.title.margin+cA[0])}if(cD.display&&!cE.floating){if(cx==="right"){if(!an(cw[1])){cz.marginRight=cu(cz.marginRight,cD.legendWidth-cB+M+cA[1])}}else{if(cx==="left"){if(!an(cw[3])){cz.plotLeft=cu(cz.plotLeft,cD.legendWidth+cB+M+cA[3])}}else{if(L==="top"){if(!an(cw[0])){cz.plotTop=cu(cz.plotTop,cD.legendHeight+cy+M+cA[0])}}else{if(L==="bottom"){if(!an(cw[2])){cz.marginBottom=cu(cz.marginBottom,cD.legendHeight-cy+M+cA[2])}}}}}}if(cz.extraBottomMargin){cz.marginBottom+=cz.extraBottomMargin}if(cz.extraTopMargin){cz.plotTop+=cz.extraTopMargin}if(cz.hasCartesianSeries){I(cz.axes,function(cG){cG.getOffset()})}if(!an(cw[3])){cz.plotLeft+=cC[3]}if(!an(cw[0])){cz.plotTop+=cC[0]}if(!an(cw[2])){cz.marginBottom+=cC[2]}if(!an(cw[1])){cz.marginRight+=cC[1]}cz.setChartSize()},reflow:function(cz){var cx=this,cB=cx.options.chart,cA=cx.renderTo,cw=cB.width||aR(cA,"width"),L=cB.height||aR(cA,"height"),cy=cz?cz.target:bf,M=function(){if(cx.container){cx.setSize(cw,L,false);cx.hasUserSize=null}};if(!cx.hasUserSize&&cw&&L&&(cy===bf||cy===bW)){if(cw!==cx.containerWidth||L!==cx.containerHeight){clearTimeout(cx.reflowTimeout);if(cz){cx.reflowTimeout=setTimeout(M,100)}else{M()}}cx.containerWidth=cw;cx.containerHeight=L}},initReflow:function(){var M=this,L=function(cw){M.reflow(cw)};z(bf,"resize",L);z(M,"destroy",function(){bh(bf,"resize",L)})},setSize:function(cz,L,cA){var cy=this,cx,M,cw;cy.isResizing+=1;cw=function(){if(cy){bM(cy,"endResize",null,function(){cy.isResizing-=1})}};cq(cA,cy);cy.oldChartHeight=cy.chartHeight;cy.oldChartWidth=cy.chartWidth;if(an(cz)){cy.chartWidth=cx=cu(0,o(cz));cy.hasUserSize=!!cx}if(an(L)){cy.chartHeight=M=cu(0,o(L))}(cv?t:cp)(cy.container,{width:cx+ab,height:M+ab},cv);cy.setChartSize(true);cy.renderer.setSize(cx,M,cA);cy.maxTicks=null;I(cy.axes,function(cB){cB.isDirty=true;cB.setScale()});I(cy.series,function(cB){cB.isDirty=true});cy.isDirtyLegend=true;cy.isDirtyBox=true;cy.getMargins();cy.redraw(cA);cy.oldChartHeight=null;bM(cy,"resize");if(cv===false){cw()}else{setTimeout(cw,(cv&&cv.duration)||500)}},setChartSize:function(cI){var cD=this,cz=cD.inverted,cC=cD.renderer,cA=cD.chartWidth,cy=cD.chartHeight,cB=cD.options.chart,cH=cD.spacing,cJ=cD.clipOffset,cx,cw,M,cG,cF,cE,L;cD.plotLeft=M=o(cD.plotLeft);cD.plotTop=cG=o(cD.plotTop);cD.plotWidth=cF=cu(0,o(cA-M-cD.marginRight));cD.plotHeight=cE=cu(0,o(cy-cG-cD.marginBottom));cD.plotSizeX=cz?cE:cF;cD.plotSizeY=cz?cF:cE;cD.plotBorderWidth=cB.plotBorderWidth||0;cD.spacingBox=cC.spacingBox={x:cH[3],y:cH[0],width:cA-cH[3]-cH[1],height:cy-cH[0]-cH[2]};cD.plotBox=cC.plotBox={x:M,y:cG,width:cF,height:cE};L=2*bE(cD.plotBorderWidth/2);cx=aK(cu(L,cJ[3])/2);cw=aK(cu(L,cJ[0])/2);cD.clipBox={x:cx,y:cw,width:bE(cD.plotSizeX-cu(L,cJ[1])/2-cx),height:bE(cD.plotSizeY-cu(L,cJ[2])/2-cw)};if(!cI){I(cD.axes,function(cK){cK.setAxisSize();cK.setAxisTranslation()})}},resetMargins:function(){var L=this,cw=L.spacing,M=L.margin;L.plotTop=a0(M[0],cw[0]);L.marginRight=a0(M[1],cw[1]);L.marginBottom=a0(M[2],cw[2]);L.plotLeft=a0(M[3],cw[3]);L.axisOffset=[0,0,0,0];L.clipOffset=[0,0,0,0]},drawChartBox:function(){var cE=this,cw=cE.options.chart,cJ=cE.renderer,cN=cE.chartWidth,cx=cE.chartHeight,cI=cE.chartBackground,cz=cE.plotBackground,cO=cE.plotBorder,cG=cE.plotBGImage,cK=cw.borderWidth||0,cQ=cw.backgroundColor,cA=cw.plotBackgroundColor,M=cw.plotBackgroundImage,cP=cw.plotBorderWidth||0,L,cB,cF=cE.plotLeft,cH=cE.plotTop,cy=cE.plotWidth,cM=cE.plotHeight,cC=cE.plotBox,cL=cE.clipRect,cD=cE.clipBox;L=cK+(cw.shadow?8:0);if(cK||cQ){if(!cI){cB={fill:cQ||B};if(cK){cB.stroke=cw.borderColor;cB["stroke-width"]=cK}cE.chartBackground=cJ.rect(L/2,L/2,cN-L,cx-L,cw.borderRadius,cK).attr(cB).addClass(bk+"background").add().shadow(cw.shadow)}else{cI.animate(cI.crisp({width:cN-L,height:cx-L}))}}if(cA){if(!cz){cE.plotBackground=cJ.rect(cF,cH,cy,cM,0).attr({fill:cA}).add().shadow(cw.plotShadow)}else{cz.animate(cC)}}if(M){if(!cG){cE.plotBGImage=cJ.image(M,cF,cH,cy,cM).add()}else{cG.animate(cC)}}if(!cL){cE.clipRect=cJ.clipRect(cD)}else{cL.animate({width:cD.width,height:cD.height})}if(cP){if(!cO){cE.plotBorder=cJ.rect(cF,cH,cy,cM,0,-cP).attr({stroke:cw.plotBorderColor,"stroke-width":cP,fill:B,zIndex:1}).add()}else{cO.animate(cO.crisp({x:cF,y:cH,width:cy,height:cM}))}}cE.isDirtyBox=false},propFromSeries:function(){var cx=this,cz=cx.options.chart,L,M=cx.options.series,cw,cy;I(["inverted","angular","polar"],function(cA){L=a[cz.type||cz.defaultSeriesType];cy=(cx[cA]||cz[cA]||(L&&L.prototype[cA]));cw=M&&M.length;while(!cy&&cw--){L=a[M[cw].type];if(L&&L.prototype[cA]){cy=true}}cx[cA]=cy})},linkSeries:function(){var L=this,M=L.series;I(M,function(cw){cw.linkedSeries.length=0});I(M,function(cx){var cw=cx.options.linkedTo;if(bK(cw)){if(cw===":previous"){cw=L.series[cx.index-1]}else{cw=L.get(cw)}if(cw){cw.linkedSeries.push(cx);cx.linkedParent=cw}}})},renderSeries:function(){I(this.series,function(L){L.translate();if(L.setTooltipPoints){L.setTooltipPoints()}L.render()})},render:function(){var cw=this,cy=cw.axes,cx=cw.renderer,L=cw.options;var cA=L.labels,M=L.credits,cz;cw.setTitle();cw.legend=new bP(cw,L.legend);cw.getStacks();I(cy,function(cB){cB.setScale()});cw.getMargins();cw.maxTicks=null;I(cy,function(cB){cB.setTickPositions(true);cB.setMaxTicks()});cw.adjustTickAmounts();cw.getMargins();cw.drawChartBox();if(cw.hasCartesianSeries){I(cy,function(cB){cB.render()})}if(!cw.seriesGroup){cw.seriesGroup=cx.g("series-group").attr({zIndex:3}).add()}cw.renderSeries();if(cA.items){I(cA.items,function(cC){var cD=bD(cA.style,cC.style),cB=b8(cD.left)+cw.plotLeft,cE=b8(cD.top)+cw.plotTop+12;delete cD.left;delete cD.top;cx.text(cC.html,cB,cE).attr({zIndex:2}).css(cD).add()})}if(M.enabled&&!cw.credits){cz=M.href;cw.credits=cx.text(M.text,0,0).on("click",function(){if(cz){location.href=cz}}).attr({align:M.position.align,zIndex:8}).css(M.style).add().align(M.position)}cw.hasRendered=true},destroy:function(){var cy=this,cz=cy.axes,cx=cy.series,M=cy.container,cw,L=M&&M.parentNode;bM(cy,"destroy");aO[cy.index]=k;cy.renderTo.removeAttribute("data-highcharts-chart");bh(cy);cw=cz.length;while(cw--){cz[cw]=cz[cw].destroy()}cw=cx.length;while(cw--){cx[cw]=cx[cw].destroy()}I(["title","subtitle","chartBackground","plotBackground","plotBGImage","plotBorder","seriesGroup","clipRect","credits","pointer","scroller","rangeSelector","legend","resetZoomButton","tooltip","renderer"],function(cA){var cB=cy[cA];if(cB&&cB.destroy){cy[cA]=cB.destroy()}});if(M){M.innerHTML="";bh(M);if(L){ca(M)}}for(cw in cy){delete cy[cw]}},isReadyToRender:function(){var L=this;if((!cl&&(bf==bf.top&&bW.readyState!=="complete"))||(bj&&!bf.canvg)){if(bj){bi.push(function(){L.firstRender()},L.options.global.canvasToolsURL)}else{bW.attachEvent("onreadystatechange",function(){bW.detachEvent("onreadystatechange",L.firstRender);if(bW.readyState==="complete"){L.firstRender()}})}return false}return true},firstRender:function(){var M=this,L=M.options,cw=M.callback;if(!M.isReadyToRender()){return}M.getContainer();bM(M,"init");M.resetMargins();M.setChartSize();M.propFromSeries();M.getAxes();I(L.series||[],function(cx){M.initSeries(cx)});M.linkSeries();bM(M,"beforeRender");if(aZ.Pointer){M.pointer=new aX(M,L)}M.render();M.renderer.draw();if(cw){cw.apply(M,[M])}I(M.callbacks,function(cx){cx.apply(M,[M])});M.cloneRenderTo(true);bM(M,"load")},splashArray:function(cx,M){var cw=M[cx],L=cr(cw)?cw:[cw,cw,cw,cw];return[a0(M[cx+"Top"],L[0]),a0(M[cx+"Right"],L[1]),a0(M[cx+"Bottom"],L[2]),a0(M[cx+"Left"],L[3])]}};bB.prototype.callbacks=[];var F=aZ.CenteredSeriesMixin={getCenter:function(){var cD=this.options,cx=this.chart,cC=2*(cD.slicedOffset||0),M,cz=cx.plotWidth-2*cC,cA=cx.plotHeight-2*cC,cB=cD.center,cw=[a0(cB[0],"50%"),a0(cB[1],"50%"),cD.size||"100%",cD.innerSize||0],cy=aw(cz,cA),L;return ar(cw,function(cF,cE){L=/%$/.test(cF);M=cE<2||(cE===2&&L);return(L?[cz,cA,cy,cy][cE]*b8(cF)/100:cF)+(M?cC:0)})}};var bU=function(){};bU.prototype={init:function(cy,cx,M){var L=this,cw;L.series=cy;L.applyOptions(cx,M);L.pointAttr={};if(cy.options.colorByPoint){cw=cy.options.colors||cy.chart.options.colors;L.color=L.color||cw[cy.colorCounter++];if(cy.colorCounter===cw.length){cy.colorCounter=0}}cy.chart.pointCount++;return L},applyOptions:function(cw,M){var L=this,cx=L.series,cy=cx.pointValKey;cw=bU.prototype.optionsToObject.call(this,cw);bD(L,cw);L.options=L.options?bD(L.options,cw):cw;if(cy){L.y=L[cy]}if(L.x===k&&cx){L.x=M===k?cx.autoIncrement():M}return L},optionsToObject:function(cy){var cx={},cA=this.series,L=cA.pointArrayMap||["y"],M=L.length,cB,cz=0,cw=0;if(typeof cy==="number"||cy===null){cx[L[0]]=cy}else{if(aP(cy)){if(cy.length>M){cB=typeof cy[0];if(cB==="string"){cx.name=cy[0]}else{if(cB==="number"){cx.x=cy[0]}}cz++}while(cw<M){cx[L[cw++]]=cy[cz++]}}else{if(typeof cy==="object"){cx=cy;if(cy.dataLabels){cA._hasPointLabels=true}if(cy.marker){cA._hasPointMarkers=true}}}}return cx},destroy:function(){var L=this,M=L.series,cx=M.chart,cw=cx.hoverPoints,cy;cx.pointCount--;if(cw){L.setState();T(cw,L);if(!cw.length){cx.hoverPoints=null}}if(L===cx.hoverPoint){L.onMouseOut()}if(L.graphic||L.dataLabel){bh(L);L.destroyElements()}if(L.legendItem){cx.legend.destroyItem(L)}for(cy in L){L[cy]=null}},destroyElements:function(){var L=this,cw=["graphic","dataLabel","dataLabelUpper","group","connector","shadowGroup"],cx,M=6;while(M--){cx=cw[M];if(L[cx]){L[cx]=L[cx].destroy()}}},getLabelConfig:function(){var L=this;return{x:L.category,y:L.y,key:L.name||L.category,series:L.series,point:L,percentage:L.percentage,total:L.total||L.stackTotal}},tooltipFormatter:function(L){var cw=this.series,M=cw.tooltipOptions,cy=a0(M.valueDecimals,""),cx=M.valuePrefix||"",cz=M.valueSuffix||"";I(cw.pointArrayMap||["y"],function(cA){cA="{point."+cA;if(cx||cz){L=L.replace(cA+"}",cx+cA+"}"+cz)}L=L.replace(cA+"}",cA+":,."+cy+"f}")});return g(L,{point:this,series:this.series})}};var bq=function(){};bq.prototype={isCartesian:true,type:"line",pointClass:bU,sorted:true,requireSorting:true,pointAttrToOptions:{stroke:"lineColor","stroke-width":"lineWidth",fill:"fillColor",r:"radius"},axisTypes:["xAxis","yAxis"],colorCounter:0,parallelArrays:["x","y"],init:function(cy,L){var cx=this,cw,M,cz=cy.series,cA=function(cC,cB){return a0(cC.options.index,cC._i)-a0(cB.options.index,cB._i)};cx.chart=cy;cx.options=L=cx.setOptions(L);cx.linkedSeries=[];cx.bindAxes();bD(cx,{name:L.name,state:au,pointAttr:{},visible:L.visible!==false,selected:L.selected===true});if(bj){L.animation=false}M=L.events;for(cw in M){z(cx,cw,M[cw])}if((M&&M.click)||(L.point&&L.point.events&&L.point.events.click)||L.allowPointSelect){cy.runTrackerClick=true}cx.getColor();cx.getSymbol();I(cx.parallelArrays,function(cB){cx[cB+"Data"]=[]});cx.setData(L.data,false);if(cx.isCartesian){cy.hasCartesianSeries=true}cz.push(cx);cx._i=cz.length-1;aQ(cz,cA);if(this.yAxis){aQ(this.yAxis.series,cA)}I(cz,function(cC,cB){cC.index=cB;cC.name=cC.name||"Series "+(cB+1)})},bindAxes:function(){var M=this,L=M.options,cw=M.chart,cx;I(M.axisTypes||[],function(cy){I(cw[cy],function(cz){cx=cz.options;if((L[cy]===cx.index)||(L[cy]!==k&&L[cy]===cx.id)||(L[cy]===k&&cx.index===0)){cz.series.push(M);M[cy]=cz;cz.isDirty=true}});if(!M[cy]&&M.optionalAxis!==cy){b9(18,true)}})},updateParallelArrays:function(L,cx){var cw=L.series,M=arguments,cy=typeof cx==="number"?function(cz){var cA=cz==="y"&&cw.toYData?cw.toYData(L):L[cz];cw[cz+"Data"][cx]=cA}:function(cz){Array.prototype[cx].apply(cw[cz+"Data"],Array.prototype.slice.call(M,2))};I(cw.parallelArrays,cy)},autoIncrement:function(){var M=this,L=M.options,cw=M.xIncrement;cw=a0(cw,L.pointStart,0);M.pointInterval=a0(M.pointInterval,L.pointInterval,1);M.xIncrement=cw+M.pointInterval;return cw},getSegments:function(){var cx=this,L=-1,M=[],cw,cz=cx.points,cy=cz.length;if(cy){if(cx.options.connectNulls){cw=cy;while(cw--){if(cz[cw].y===null){cz.splice(cw,1)}}if(cz.length){M=[cz]}}else{I(cz,function(cA,cB){if(cA.y===null){if(cB>L+1){M.push(cz.slice(L+1,cB))}L=cB}else{if(cB===cy-1){M.push(cz.slice(L+1,cB+1))}}})}}cx.segments=M},setOptions:function(cx){var cw=this.chart,cA=cw.options,L=cA.plotOptions,cB=cw.userOptions||{},cz=cB.plotOptions||{},cy=L[this.type],M;this.userOptions=cx;M=aY(cy,L.series,cx);this.tooltipOptions=aY(bS.tooltip,bS.plotOptions[this.type].tooltip,cB.tooltip,cz.series&&cz.series.tooltip,cz[this.type]&&cz[this.type].tooltip,cx.tooltip);if(cy.marker===null){delete M.marker}return M},getColor:function(){var M=this.options,cy=this.userOptions,cx=this.chart.options.colors,cw=this.chart.counters,L,cz;L=M.color||at[this.type].color;if(!L&&!M.colorByPoint){if(an(cy._colorIndex)){cz=cy._colorIndex}else{cy._colorIndex=cw.color;cz=cw.color++}L=cx[cz]}this.color=L;cw.wrapColor(cx.length)},getSymbol:function(){var cw=this,cA=cw.userOptions,cz=cw.options.marker,cy=cw.chart,L=cy.options.symbols,cx=cy.counters,M;cw.symbol=cz.symbol;if(!cw.symbol){if(an(cA._symbolIndex)){M=cA._symbolIndex}else{cA._symbolIndex=cx.symbol;M=cx.symbol++}cw.symbol=L[M]}if(/^url/.test(cw.symbol)){cz.radius=0}cx.wrapSymbol(L.length)},drawLegendSymbol:G.drawLineMarker,setData:function(cQ,cI,cN,cw){var cD=this,cP=cD.points,cJ=(cP&&cP.length)||0,cA,M=cD.options,cF=cD.chart,cE=null,cB=cD.xAxis,cL=cB&&!!cB.categories,cz=cD.tooltipPoints,cK,L=M.turboThreshold,cH,cy=this.xData,cO=this.yData,cG=cD.pointArrayMap,cx=cG&&cG.length;cQ=cQ||[];cA=cQ.length;cI=a0(cI,true);if(cw!==false&&cA&&cJ===cA&&!cD.cropped&&!cD.hasGroupedData){I(cQ,function(cR,cS){cP[cS].update(cR,false)})}else{cD.xIncrement=null;cD.pointRange=cL?1:M.pointRange;cD.colorCounter=0;I(this.parallelArrays,function(cR){cD[cR+"Data"].length=0});if(L&&cA>L){cK=0;while(cE===null&&cK<cA){cE=cQ[cK];cK++}if(aD(cE)){var cC=a0(M.pointStart,0),cM=a0(M.pointInterval,1);for(cK=0;cK<cA;cK++){cy[cK]=cC;cO[cK]=cQ[cK];cC+=cM}cD.xIncrement=cC}else{if(aP(cE)){if(cx){for(cK=0;cK<cA;cK++){cH=cQ[cK];cy[cK]=cH[0];cO[cK]=cH.slice(1,cx+1)}}else{for(cK=0;cK<cA;cK++){cH=cQ[cK];cy[cK]=cH[0];cO[cK]=cH[1]}}}else{b9(12)}}}else{for(cK=0;cK<cA;cK++){if(cQ[cK]!==k){cH={series:cD};cD.pointClass.prototype.applyOptions.apply(cH,[cQ[cK]]);cD.updateParallelArrays(cH,cK);if(cL&&cH.name){cB.names[cH.x]=cH.name}}}}if(bK(cO[0])){b9(14,true)}cD.data=[];cD.options.data=cQ;cK=cJ;while(cK--){if(cP[cK]&&cP[cK].destroy){cP[cK].destroy()}}if(cz){cz.length=0}if(cB){cB.minRange=cB.userMinRange}cD.isDirty=cD.isDirtyData=cF.isDirtyBox=true;cN=false}if(cI){cF.redraw(cN)}},processData:function(M){var cC=this,cJ=cC.xData,cH=cC.yData,cx=cJ.length,cD,cI=0,cE,L,cG,cw=cC.xAxis,cB,cK=cC.options,cz=cK.cropThreshold,cy=cC.isCartesian;if(cy&&!cC.isDirty&&!cw.isDirty&&!cC.yAxis.isDirty&&!M){return false}if(cy&&cC.sorted&&(!cz||cx>cz||cC.forceCrop)){var cA=cw.min,cF=cw.max;if(cJ[cx-1]<cA||cJ[0]>cF){cJ=[];cH=[]}else{if(cJ[0]<cA||cJ[cx-1]>cF){cD=this.cropData(cC.xData,cC.yData,cA,cF);cJ=cD.xData;cH=cD.yData;cI=cD.start;cE=true}}}for(cB=cJ.length-1;cB>=0;cB--){L=cJ[cB]-cJ[cB-1];if(L>0&&(cG===k||L<cG)){cG=L}else{if(L<0&&cC.requireSorting){b9(15)}}}cC.cropped=cE;cC.cropStart=cI;cC.processedXData=cJ;cC.processedYData=cH;if(cK.pointRange===null){cC.pointRange=cG||1}cC.closestPointRange=cG},cropData:function(cx,cw,cy,cA){var L=cx.length,cB=0,M=L,cC=a0(this.cropShoulder,1),cz;for(cz=0;cz<L;cz++){if(cx[cz]>=cy){cB=cu(0,cz-cC);break}}for(;cz<L;cz++){if(cx[cz]>cA){M=cz+cC;break}}return{xData:cx.slice(cB,M),yData:cw.slice(cB,M),start:cB,end:M}},generatePoints:function(){var cy=this,cJ=cy.options,cI=cJ.data,cx=cy.data,L,cF=cy.processedXData,cB=cy.processedYData,cA=cy.pointClass,M=cF.length,cE=cy.cropStart||0,cH,cD=cy.hasGroupedData,cC,cG=[],cw;if(!cx&&!cD){var cz=[];cz.length=cI.length;cx=cy.data=cz}for(cw=0;cw<M;cw++){cH=cE+cw;if(!cD){if(cx[cH]){cC=cx[cH]}else{if(cI[cH]!==k){cx[cH]=cC=(new cA()).init(cy,cI[cH],cF[cw])}}cG[cw]=cC}else{cG[cw]=(new cA()).init(cy,[cF[cw]].concat(bw(cB[cw])))}}if(cx&&(M!==(L=cx.length)||cD)){for(cw=0;cw<L;cw++){if(cw===cE&&!cD){cw+=M}if(cx[cw]){cx[cw].destroyElements();cx[cw].plotX=k}}}cy.data=cx;cy.points=cG},getExtremes:function(cG){var cy=this.xAxis,L=this.yAxis,M=this.processedXData,cF,cx=[],cB=0,cw=cy.getExtremes(),cH=cw.min,cJ=cw.max,cE,cK,cI,cL,cA,cz,cD,cC;cG=cG||this.stackedYData||this.processedYData;cF=cG.length;for(cD=0;cD<cF;cD++){cA=M[cD];cz=cG[cD];cE=cz!==null&&cz!==k&&(!L.isLog||(cz.length||cz>0));cK=this.getExtremesFromAll||this.cropped||((M[cD+1]||cA)>=cH&&(M[cD-1]||cA)<=cJ);if(cE&&cK){cC=cz.length;if(cC){while(cC--){if(cz[cC]!==null){cx[cB++]=cz[cC]}}}else{cx[cB++]=cz}}}this.dataMin=a0(cI,bY(cx));this.dataMax=a0(cL,aS(cx))},translate:function(){if(!this.processedXData){this.processData()}this.generatePoints();var cD=this,cy=cD.options,cw=cy.stacking,cC=cD.xAxis,cE=cC.categories,M=cD.yAxis,cI=cD.points,cB=cI.length,cN=!!cD.modifyValue,cJ,cF=cy.pointPlacement,cK=cF==="between"||aD(cF),cz=cy.threshold;for(cJ=0;cJ<cB;cJ++){var cG=cI[cJ],cH=cG.x,cL=cG.y,L=cG.low,cA=cw&&M.stacks[(cD.negStacks&&cL<cz?"-":"")+cD.stackKey],cM,cx;if(M.isLog&&cL<=0){cG.y=cL=null}cG.plotX=cC.translate(cH,0,0,0,1,cF,this.type==="flags");if(cw&&cD.visible&&cA&&cA[cH]){cM=cA[cH];cx=cM.points[cD.index];L=cx[0];cL=cx[1];if(L===0){L=a0(cz,M.min)}if(M.isLog&&L<=0){L=null}cG.total=cG.stackTotal=cM.total;cG.percentage=cM.total&&(cG.y/cM.total*100);cG.stackY=cL;cM.setOffset(cD.pointXOffset||0,cD.barW||0)}cG.yBottom=an(L)?M.translate(L,0,1,0,1):null;if(cN){cL=cD.modifyValue(cL,cG)}cG.plotY=(typeof cL==="number"&&cL!==Infinity)?M.translate(cL,0,1,0,1):k;cG.clientX=cK?cC.translate(cH,0,0,0,1):cG.plotX;cG.negative=cG.y<(cz||0);cG.category=cE&&cE[cG.x]!==k?cE[cG.x]:cG.x}cD.getSegments()},animate:function(cD){var cA=this,cC=cA.chart,cB=cC.renderer,cz,cy,cx=cA.options.animation,L=cC.clipBox,cw=cC.inverted,M;if(cx&&!cr(cx)){cx=at[cA.type].animation}M="_sharedClip"+cx.duration+cx.easing;if(cD){cz=cC[M];cy=cC[M+"m"];if(!cz){cC[M]=cz=cB.clipRect(bD(L,{width:0}));cC[M+"m"]=cy=cB.clipRect(-99,cw?-cC.plotLeft:-cC.plotTop,99,cw?cC.chartWidth:cC.chartHeight)}cA.group.clip(cz);cA.markerGroup.clip(cy);cA.sharedClipKey=M}else{cz=cC[M];if(cz){cz.animate({width:cC.plotSizeX},cx);cC[M+"m"].animate({width:cC.plotSizeX+99},cx)}cA.animate=null;cA.animationTimeout=setTimeout(function(){cA.afterAnimate()},cx.duration)}},afterAnimate:function(){var L=this.chart,cw=this.sharedClipKey,M=this.group;if(M&&this.options.clip!==false){M.clip(L.clipRect);this.markerGroup.clip()}setTimeout(function(){if(cw&&L[cw]){L[cw]=L[cw].destroy();L[cw+"m"]=L[cw+"m"].destroy()}},100)},drawPoints:function(){var cA=this,cC,cJ=cA.points,cE=cA.chart,cx,L,cK,cG,cw,cH,cI,cD,M=cA.options,cM=M.marker,cL=cA.pointAttr[""],cF,cz,cy,cB=cA.markerGroup;if(cM.enabled||cA._hasPointMarkers){cK=cJ.length;while(cK--){cG=cJ[cK];cx=bE(cG.plotX);L=cG.plotY;cD=cG.graphic;cF=cG.marker||{};cz=(cM.enabled&&cF.enabled===k)||cF.enabled;cy=cE.isInsidePlot(o(cx),L,cE.inverted);if(cz&&L!==k&&!isNaN(L)&&cG.y!==null){cC=cG.pointAttr[cG.selected?bJ:au]||cL;cw=cC.r;cH=a0(cF.symbol,cA.symbol);cI=cH.indexOf("url")===0;if(cD){cD.attr({visibility:cy?"inherit":ap}).animate(bD({x:cx-cw,y:L-cw},cD.symbolName?{width:2*cw,height:2*cw}:{}))}else{if(cy&&(cw>0||cI)){cG.graphic=cD=cE.renderer.symbol(cH,cx-cw,L-cw,2*cw,2*cw).attr(cC).add(cB)}}}else{if(cD){cG.graphic=cD.destroy()}}}}},convertAttribs:function(cw,M,cB,cA){var cy=this.pointAttrToOptions,L,cx,cz={};cw=cw||{};M=M||{};cB=cB||{};cA=cA||{};for(L in cy){cx=cy[L];cz[L]=a0(cw[cx],M[L],cB[L],cA[L])}return cz},getAttribs:function(){var cA=this,cz=cA.options,cx=at[cA.type].marker?cz.marker:cz,L=cx.states,cC=L[a2],cN,cw=cA.color,cM={stroke:cw,fill:cw},cG=cA.points||[],cH,cE,cI=[],cB,cF=cA.pointAttrToOptions,cK=cA.hasPointSpecificOptions,cJ=cz.negativeColor,cy=cx.lineColor,cL=cx.fillColor,M=cz.turboThreshold,cD,cO;if(cz.marker){cC.radius=cC.radius||cx.radius+2;cC.lineWidth=cC.lineWidth||cx.lineWidth+1}else{cC.color=cC.color||b6(cC.color||cw).brighten(cC.brightness).get()}cI[au]=cA.convertAttribs(cx,cM);I([a2,bJ],function(cP){cI[cP]=cA.convertAttribs(L[cP],cI[au])});cA.pointAttr=cI;cH=cG.length;if(!M||cH<M||cK){while(cH--){cE=cG[cH];cx=(cE.options&&cE.options.marker)||cE.options;if(cx&&cx.enabled===false){cx.radius=0}if(cE.negative&&cJ){cE.color=cE.fillColor=cJ}cK=cz.colorByPoint||cE.color;if(cE.options){for(cO in cF){if(an(cx[cF[cO]])){cK=true}}}if(cK){cx=cx||{};cB=[];L=cx.states||{};cN=L[a2]=L[a2]||{};if(!cz.marker){cN.color=cN.color||(!cE.options.color&&cC.color)||b6(cE.color).brighten(cN.brightness||cC.brightness).get()}cD={color:cE.color};if(!cL){cD.fillColor=cE.color}if(!cy){cD.lineColor=cE.color}cB[au]=cA.convertAttribs(bD(cD,cx),cI[au]);cB[a2]=cA.convertAttribs(L[a2],cI[a2],cB[au]);cB[bJ]=cA.convertAttribs(L[bJ],cI[bJ],cB[au])}else{cB=cI}cE.pointAttr=cB}}},destroy:function(){var cx=this,cz=cx.chart,cC=/AppleWebKit\/533/.test(u),cA,cy,cw=cx.data||[],cB,L,M;bM(cx,"destroy");bh(cx);I(cx.axisTypes||[],function(cD){M=cx[cD];if(M){T(M.series,cx);M.isDirty=M.forceRedraw=true}});if(cx.legendItem){cx.chart.legend.destroyItem(cx)}cy=cw.length;while(cy--){cB=cw[cy];if(cB&&cB.destroy){cB.destroy()}}cx.points=null;clearTimeout(cx.animationTimeout);I(["area","graph","dataLabelsGroup","group","markerGroup","tracker","graphNeg","areaNeg","posClip","negClip"],function(cD){if(cx[cD]){cA=cC&&cD==="group"?"hide":"destroy";cx[cD][cA]()}});if(cz.hoverSeries===cx){cz.hoverSeries=null}T(cz.series,cx);for(L in cx){delete cx[L]}},getSegmentPath:function(cx){var M=this,L=[],cw=M.options.step;I(cx,function(cy,cB){var cA=cy.plotX,cz=cy.plotY,cC;if(M.getPointSpline){L.push.apply(L,M.getPointSpline(cx,cy,cB))}else{L.push(cB?bO:bN);if(cw&&cB){cC=cx[cB-1];if(cw==="right"){L.push(cC.plotX,cz)}else{if(cw==="center"){L.push((cC.plotX+cA)/2,cC.plotY,(cC.plotX+cA)/2,cz)}else{L.push(cA,cC.plotY)}}}L.push(cy.plotX,cy.plotY)}});return L},getGraphPath:function(){var cw=this,cx=[],L,M=[];I(cw.segments,function(cy){L=cw.getSegmentPath(cy);if(cy.length>1){cx=cx.concat(L)}else{M.push(cy[0])}});cw.singlePoints=M;cw.graphPath=cx;return cx},drawGraph:function(){var cw=this,M=this.options,cx=[["graph",M.lineColor||this.color]],L=M.lineWidth,cz=M.dashStyle,cB=M.linecap!=="square",cA=this.getGraphPath(),cy=M.negativeColor;if(cy){cx.push(["graphNeg",cy])}I(cx,function(cG,cC){var cF=cG[0],cD=cw[cF],cE;if(cD){bb(cD);cD.animate({d:cA})}else{if(L&&cA.length){cE={stroke:cG[1],"stroke-width":L,fill:B,zIndex:1};if(cz){cE.dashstyle=cz}else{if(cB){cE["stroke-linecap"]=cE["stroke-linejoin"]="round"}}cw[cF]=cw.chart.renderer.path(cA).attr(cE).add(cw.group).shadow(!cC&&M.shadow)}}})},clipNeg:function(){var cK=this.options,cD=this.chart,cC=cD.renderer,cz=cK.negativeColor||cK.negativeFillColor,cI,cG,cB,cJ=this.graph,M=this.area,cy=this.posClip,cw=this.negClip,cA=cD.chartWidth,cx=cD.chartHeight,cF=cu(cA,cx),L=this.yAxis,cE,cH;if(cz&&(cJ||M)){cI=o(L.toPixels(cK.threshold||0,true));if(cI<0){cF-=cI}cE={x:0,y:0,width:cF,height:cI};cH={x:0,y:cI,width:cF,height:cF};if(cD.inverted){cE.height=cH.y=cD.plotWidth-cI;if(cC.isVML){cE={x:cD.plotWidth-cI-cD.plotLeft,y:0,width:cA,height:cx};cH={x:cI+cD.plotLeft-cA,y:0,width:cD.plotLeft+cI,height:cA}}}if(L.reversed){cG=cH;cB=cE}else{cG=cE;cB=cH}if(cy){cy.animate(cG);cw.animate(cB)}else{this.posClip=cy=cC.clipRect(cG);this.negClip=cw=cC.clipRect(cB);if(cJ&&this.graphNeg){cJ.clip(cy);this.graphNeg.clip(cw)}if(M){M.clip(cy);this.areaNeg.clip(cw)}}}},invertGroups:function(){var L=this,M=L.chart;if(!L.xAxis){return}function cw(){var cx={width:L.yAxis.len,height:L.xAxis.len};I(["group","markerGroup"],function(cy){if(L[cy]){L[cy].attr(cx).invert()}})}z(M,"resize",cw);z(L,"destroy",function(){bh(M,"resize",cw)});cw();L.invertGroups=cw},plotGroup:function(cA,cw,M,cz,cx){var cy=this[cA],L=!cy;if(L){this[cA]=cy=this.chart.renderer.g(cw).attr({visibility:M,zIndex:cz||0.1}).add(cx)}cy[L?"attr":"animate"](this.getPlotBox());return cy},getPlotBox:function(){return{translateX:this.xAxis?this.xAxis.left:this.chart.plotLeft,translateY:this.yAxis?this.yAxis.top:this.chart.plotTop,scaleX:1,scaleY:1}},render:function(){var cw=this,cy=cw.chart,cB,cD=cw.options,M=cD.animation,cC=M&&!!cw.animate&&cy.renderer.isSVG,L=cw.visible?av:ap,cz=cD.zIndex,cx=cw.hasRendered,cA=cy.seriesGroup;cB=cw.plotGroup("group","series",L,cz,cA);cw.markerGroup=cw.plotGroup("markerGroup","markers",L,cz,cA);if(cC){cw.animate(true)}cw.getAttribs();cB.inverted=cw.isCartesian?cy.inverted:false;if(cw.drawGraph){cw.drawGraph();cw.clipNeg()}if(cw.drawDataLabels){cw.drawDataLabels()}if(cw.visible){cw.drawPoints()}if(cw.drawTracker&&cw.options.enableMouseTracking!==false){cw.drawTracker()}if(cy.inverted){cw.invertGroups()}if(cD.clip!==false&&!cw.sharedClipKey&&!cx){cB.clip(cy.clipRect)}if(cC){cw.animate()}else{if(!cx){cw.afterAnimate()}}cw.isDirty=cw.isDirtyData=false;cw.hasRendered=true},redraw:function(){var cw=this,cx=cw.chart,L=cw.isDirtyData,cz=cw.group,cy=cw.xAxis,M=cw.yAxis;if(cz){if(cx.inverted){cz.attr({width:cx.plotWidth,height:cx.plotHeight})}cz.animate({translateX:a0(cy&&cy.left,cx.plotLeft),translateY:a0(M&&M.top,cx.plotTop)})}cw.translate();cw.setTooltipPoints(true);cw.render();if(L){bM(cw,"updatedData")}}};function aG(cz,cx,M,L,cA,cy){var cw=cz.chart.inverted;this.axis=cz;this.isNegative=M;this.options=cx;this.x=L;this.total=null;this.points={};this.stack=cA;this.percent=cy==="percent";this.alignOptions={align:cx.align||(cw?(M?"left":"right"):"center"),verticalAlign:cx.verticalAlign||(cw?"middle":(M?"bottom":"top")),y:a0(cx.y,cw?4:(M?14:-6)),x:a0(cx.x,cw?(M?-6:6):0)};this.textAlign=cx.textAlign||(cw?(M?"right":"left"):"center")}aG.prototype={destroy:function(){bp(this,this.axis)},render:function(cw){var M=this.options,L=M.format,cx=L?g(L,this):M.formatter.call(this);if(this.label){this.label.attr({text:cx,visibility:ap})}else{this.label=this.axis.chart.renderer.text(cx,0,0,M.useHTML).css(M.style).attr({align:this.textAlign,rotation:M.rotation,visibility:ap}).add(cw)}},setOffset:function(cA,cD){var cH=this,L=cH.axis,cB=L.chart,cw=cB.inverted,M=this.isNegative,cE=L.translate(this.percent?100:this.total,0,0,0,1),cz=L.translate(0),cy=f(cE-cz),cG=cB.xAxis[0].translate(this.x)+cA,cC=cB.plotHeight,cI={x:cw?(M?cE:cE-cy):cG,y:cw?cC-cG-cD:(M?(cC-cE-cy):cC-cE),width:cw?cy:cD,height:cw?cD:cy},cF=this.label,cx;if(cF){cF.align(this.alignOptions,null,cI);cx=cF.alignAttr;cF[this.options.crop===false||cB.isInsidePlot(cx.x,cx.y)?"show":"hide"](true)}}};C.prototype.buildStacks=function(){var M=this.series,cw=a0(this.options.reversedStacks,true),L=M.length;if(!this.isXAxis){this.usePercentage=false;while(L--){M[cw?L:M.length-L-1].setStackedPoints()}if(this.usePercentage){for(L=0;L<M.length;L++){M[L].setPercentStacks()}}}};C.prototype.renderStackTotals=function(){var cz=this,cy=cz.chart,cA=cy.renderer,cx=cz.stacks,L,cB,cw,M=cz.stackTotalGroup;if(!M){cz.stackTotalGroup=M=cA.g("stack-labels").attr({visibility:av,zIndex:6}).add()}M.translate(cy.plotLeft,cy.plotTop);for(L in cx){cB=cx[L];for(cw in cB){cB[cw].render(M)}}};bq.prototype.setStackedPoints=function(){if(!this.options.stacking||(this.visible!==true&&this.chart.options.chart.ignoreHiddenSeries!==false)){return}var cF=this,cz=cF.processedXData,cL=cF.processedYData,cN=[],cK=cL.length,cB=cF.options,cx=cB.threshold,cH=cB.stack,cw=cB.stacking,M=cF.stackKey,cE="-"+M,cP=cF.negStacks,L=cF.yAxis,cM=L.stacks,cI=L.oldStacks,cG,cA,cy,cO,cJ,cD,cC;for(cJ=0;cJ<cK;cJ++){cD=cz[cJ];cC=cL[cJ];cG=cP&&cC<cx;cO=cG?cE:M;if(!cM[cO]){cM[cO]={}}if(!cM[cO][cD]){if(cI[cO]&&cI[cO][cD]){cM[cO][cD]=cI[cO][cD];cM[cO][cD].total=null}else{cM[cO][cD]=new aG(L,L.options.stackLabels,cG,cD,cH,cw)}}cA=cM[cO][cD];cA.points[cF.index]=[cA.cum||0];if(cw==="percent"){cy=cG?M:cE;if(cP&&cM[cy]&&cM[cy][cD]){cy=cM[cy][cD];cA.total=cy.total=cu(cy.total,cA.total)+f(cC)||0}else{cA.total=al(cA.total+(f(cC)||0))}}else{cA.total=al(cA.total+(cC||0))}cA.cum=(cA.cum||0)+(cC||0);cA.points[cF.index].push(cA.cum);cN[cJ]=cA.cum}if(cw==="percent"){L.usePercentage=true}this.stackedYData=cN;L.oldStacks={}};bq.prototype.setPercentStacks=function(){var cw=this,L=cw.stackKey,cx=cw.yAxis.stacks,M=cw.processedXData;I([L,"-"+L],function(cB){var cA=M.length,cz,cy,cC,cD;while(cA--){cz=M[cA];cy=cx[cB]&&cx[cB][cz];cC=cy&&cy.points[cw.index];if(cC){cD=cy.total?100/cy.total:0;cC[0]=al(cC[0]*cD);cC[1]=al(cC[1]*cD);cw.stackedYData[cA]=cC[1]}}})};bD(bB.prototype,{addSeries:function(L,cy,cx){var M,cw=this;if(L){cy=a0(cy,true);bM(cw,"addSeries",{options:L},function(){M=cw.initSeries(L);cw.isDirtyLegend=true;cw.linkSeries();if(cy){cw.redraw(cx)}})}return M},addAxis:function(L,cy,cA,cx){var M=cy?"xAxis":"yAxis",cz=this.options,cw;cw=new C(this,aY(L,{index:this[M].length,isX:cy}));cz[M]=bw(cz[M]||{});cz[M].push(L);if(a0(cA,true)){this.redraw(cx)}},showLoading:function(cy){var cw=this,L=cw.options,cx=cw.loadingDiv;var M=L.loading;if(!cx){cw.loadingDiv=cx=bF(P,{className:bk+"loading"},bD(M.style,{zIndex:10,display:B}),cw.container);cw.loadingSpan=bF("span",null,M.labelStyle,cx)}cw.loadingSpan.innerHTML=cy||L.lang.loading;if(!cw.loadingShown){cp(cx,{opacity:0,display:"",left:cw.plotLeft+ab,top:cw.plotTop+ab,width:cw.plotWidth+ab,height:cw.plotHeight+ab});t(cx,{opacity:M.style.opacity},{duration:M.showDuration||0});cw.loadingShown=true}},hideLoading:function(){var L=this.options,M=this.loadingDiv;if(M){t(M,{opacity:0},{duration:L.loading.hideDuration||100,complete:function(){cp(M,{display:B})}})}this.loadingShown=false}});bD(bU.prototype,{update:function(cD,cC,cw){var cB=this,cy=cB.series,L=cB.graphic,cz,cx=cy.data,cA=cy.chart,M=cy.options;cC=a0(cC,true);cB.firePointEvent("update",{options:cD},function(){cB.applyOptions(cD);if(cr(cD)){cy.getAttribs();if(L){if(cD&&cD.marker&&cD.marker.symbol){cB.graphic=L.destroy()}else{L.attr(cB.pointAttr[cB.state||""])}}if(cD&&cD.dataLabels&&cB.dataLabel){cB.dataLabel=cB.dataLabel.destroy()}}cz=A(cB,cx);cy.updateParallelArrays(cB,cz);M.data[cz]=cB.options;cy.isDirty=cy.isDirtyData=true;if(!cy.fixedBox&&cy.hasCartesianSeries){cA.isDirtyBox=true}if(M.legendType==="point"){cA.legend.destroyItem(cB)}if(cC){cA.redraw(cw)}})},remove:function(cB,cA){var L=this,cw=L.series,cy=cw.points,cx=cw.chart,M,cz=cw.data;cq(cA,cx);cB=a0(cB,true);L.firePointEvent("remove",null,function(){M=A(L,cz);if(cz.length===cy.length){cy.splice(M,1)}cz.splice(M,1);cw.options.data.splice(M,1);cw.updateParallelArrays(L,"splice",M,1);L.destroy();cw.isDirty=true;cw.isDirtyData=true;if(cB){cx.redraw()}})}});bD(bq.prototype,{updateNavigator:function(L){if(this.chart.scroller){this.chart.redraw();this.chart.scroller.updatedDataHandler(null,true,L)}},addPoint:function(M,cH,cI,cJ){var cA=this,cx=cA.options,cL=cA.data,L=cA.graph,cK=cA.area,cE=cA.chart,cD=cA.xAxis&&cA.xAxis.names,cC=(L&&L.shift)||0,cB=cx.data,cF,cy,cw=cA.xData,cz,cG;cq(cJ,cE);if(cI){I([L,cK,cA.graphNeg,cA.areaNeg],function(cM){if(cM){cM.shift=cC+1}})}if(cK){cK.isArea=true}cH=a0(cH,true);cF={series:cA};cA.pointClass.prototype.applyOptions.apply(cF,[M]);cz=cF.x;cG=cw.length;if(cA.requireSorting&&cz<cw[cG-1]){cy=true;while(cG&&cw[cG-1]>cz){cG--}}cA.updateParallelArrays(cF,"splice",cG,0,0);cA.updateParallelArrays(cF,cG);if(cD){cD[cz]=cF.name}cB.splice(cG,0,M);if(cy){cA.data.splice(cG,0,null);cA.processData()}if(cx.legendType==="point"){cA.generatePoints()}if(cI){if(cL[0]&&cL[0].remove){cL[0].remove(false)}else{cL.shift();cA.updateParallelArrays(cF,"shift");cB.shift()}}cA.isDirty=true;cA.isDirtyData=true;if(cH){cA.getAttribs();cE.redraw()}},remove:function(cx,cw){var L=this,M=L.chart;cx=a0(cx,true);if(!L.isRemoving){L.isRemoving=true;bM(L,"remove",null,function(){L.destroy();M.isDirtyLegend=M.isDirtyBox=true;M.linkSeries();if(cx){M.redraw(cw)}})}L.isRemoving=false},update:function(cy,cA){var M=this.chart,L=this.userOptions,cx=this.type,cw=a[cx].prototype,cz;cy=aY(L,{animation:false,index:this.index,pointStart:this.xData[0]},{data:this.options.data},cy);this.remove(false);for(cz in cw){if(cw.hasOwnProperty(cz)){this[cz]=k}}bD(this,a[cy.type||cx].prototype);this.init(M,cy);if(a0(cA,true)){M.redraw(false)}}});bD(C.prototype,{update:function(M,cw){var L=this.chart;M=L.options[this.coll][this.options.index]=aY(this.userOptions,M);this.destroy(true);this._addedPlotLB=this.userMin=this.userMax=k;this.init(L,bD(M,{events:k}));L.isDirtyBox=true;if(a0(cw,true)){L.redraw()}},remove:function(cy){var cx=this.chart,cw=this.coll,L=this.series,M=L.length;while(M--){if(L[M]){L[M].remove(false)}}T(cx.axes,this);T(cx[cw],this);cx.options[cw].splice(this.options.index,1);I(cx[cw],function(cA,cz){cA.options.index=cz});this.destroy();cx.isDirtyBox=true;if(a0(cy,true)){cx.redraw()}},setTitle:function(L,M){this.update({title:L},M)},setCategories:function(L,M){this.update({categories:L},M)}});var X=bA(bq);a.line=X;at.area=aY(a6,{threshold:0});var aL=bA(bq,{type:"area",getSegments:function(){var cA=[],cB=[],cG=[],cx=this.xAxis,cw=this.yAxis,cD=cw.stacks[this.stackKey],cC={},M,cH,cF=this.points,L=this.options.connectNulls,cy,cz,cE;if(this.options.stacking&&!this.cropped){for(cz=0;cz<cF.length;cz++){cC[cF[cz].x]=cF[cz]}for(cE in cD){if(cD[cE].total!==null){cG.push(+cE)}}cG.sort(function(cJ,cI){return cJ-cI});I(cG,function(cI){if(L&&(!cC[cI]||cC[cI].y===null)){return}else{if(cC[cI]){cB.push(cC[cI])}else{M=cx.translate(cI);cy=cD[cI].percent?(cD[cI].total?cD[cI].cum*100/cD[cI].total:0):cD[cI].cum;cH=cw.toPixels(cy,true);cB.push({y:null,plotX:M,clientX:M,plotY:cH,yBottom:cH,onMouseOver:j})}}});if(cB.length){cA.push(cB)}}else{bq.prototype.getSegments.call(this);cA=this.segments}this.segments=cA},getSegmentPath:function(cz){var M=bq.prototype.getSegmentPath.call(this,cz),cB=[].concat(M),cy,cx=this.options,cw=M.length,cA=this.yAxis.getThreshold(cx.threshold),L;if(cw===3){cB.push(bO,M[1],M[2])}if(cx.stacking&&!this.closedStacks){for(cy=cz.length-1;cy>=0;cy--){L=a0(cz[cy].yBottom,cA);if(cy<cz.length-1&&cx.step){cB.push(cz[cy+1].plotX,L)}cB.push(cz[cy].plotX,L)}}else{this.closeSegment(cB,cz,cA)}this.areaPath=this.areaPath.concat(cB);return M},closeSegment:function(M,L,cw){M.push(bO,L[L.length-1].plotX,cw,bO,L[0].plotX,cw)},drawGraph:function(){this.areaPath=[];bq.prototype.drawGraph.apply(this);var cw=this,M=this.areaPath,L=this.options,cz=L.negativeColor,cy=L.negativeFillColor,cx=[["area",this.color,L.fillColor]];if(cz||cy){cx.push(["areaNeg",cz,cy])}I(cx,function(cC){var cA=cC[0],cB=cw[cA];if(cB){cB.animate({d:M})}else{cw[cA]=cw.chart.renderer.path(M).attr({fill:a0(cC[2],b6(cC[1]).setOpacity(a0(L.fillOpacity,0.75)).get()),zIndex:0}).add(cw.group)}})},drawLegendSymbol:G.drawRectangle});a.area=aL;at.spline=aY(a6);var b=bA(bq,{type:"spline",getPointSpline:function(M,cH,cI){var cF=1.5,L=cF+1,cy=cH.plotX,cw=cH.plotY,cx=M[cI-1],cJ=M[cI+1],cC,cB,cE,cD,cM;if(cx&&cJ){var cA=cx.plotX,cz=cx.plotY,cL=cJ.plotX,cK=cJ.plotY,cG;cC=(cF*cy+cA)/L;cB=(cF*cw+cz)/L;cE=(cF*cy+cL)/L;cD=(cF*cw+cK)/L;cG=((cD-cB)*(cE-cy))/(cE-cC)+cw-cD;cB+=cG;cD+=cG;if(cB>cz&&cB>cw){cB=cu(cz,cw);cD=2*cw-cB}else{if(cB<cz&&cB<cw){cB=aw(cz,cw);cD=2*cw-cB}}if(cD>cK&&cD>cw){cD=cu(cK,cw);cB=2*cw-cD}else{if(cD<cK&&cD<cw){cD=aw(cK,cw);cB=2*cw-cD}}cH.rightContX=cE;cH.rightContY=cD}if(!cI){cM=[bN,cy,cw]}else{cM=["C",cx.rightContX||cx.plotX,cx.rightContY||cx.plotY,cC||cy,cB||cw,cy,cw];cx.rightContX=cx.rightContY=null}return cM}});a.spline=b;at.areaspline=aY(at.area);var be=aL.prototype,x=bA(b,{type:"areaspline",closedStacks:true,getSegmentPath:be.getSegmentPath,closeSegment:be.closeSegment,drawGraph:be.drawGraph,drawLegendSymbol:G.drawRectangle});a.areaspline=x;at.column=aY(a6,{borderColor:"#FFFFFF",borderWidth:1,borderRadius:0,groupPadding:0.2,marker:null,pointPadding:0.1,minPointLength:0,cropThreshold:50,pointRange:null,states:{hover:{brightness:0.1,shadow:false},select:{color:"#C0C0C0",borderColor:"#000000",shadow:false}},dataLabels:{align:null,verticalAlign:null,y:null},stickyTracking:false,threshold:0});var i=bA(bq,{type:"column",pointAttrToOptions:{stroke:"borderColor","stroke-width":"borderWidth",fill:"color",r:"borderRadius"},cropShoulder:0,trackerGroups:["group","dataLabelsGroup"],negStacks:true,init:function(){bq.prototype.init.apply(this,arguments);var L=this,M=L.chart;if(M.hasRendered){I(M.series,function(cw){if(cw.type===L.type){cw.isDirty=true}})}},getColumnMetrics:function(){var cC=this,cx=cC.options,cB=cC.xAxis,L=cC.yAxis,M=cB.reversed,cw,cL={},cJ,cK=0;if(cx.grouping===false){cK=1}else{I(cC.chart.series,function(cN){var cM=cN.options,cO=cN.yAxis;if(cN.type===cC.type&&cN.visible&&L.len===cO.len&&L.pos===cO.pos){if(cM.stacking){cw=cN.stackKey;if(cL[cw]===k){cL[cw]=cK++}cJ=cL[cw]}else{if(cM.grouping!==false){cJ=cK++}}cN.columnIndex=cJ}})}var cy=aw(f(cB.transA)*(cB.ordinalSlope||cx.pointRange||cB.closestPointRange||cB.tickInterval||1),cB.len),cH=cy*cx.groupPadding,cD=cy-2*cH,cG=cD/cK,cF=cx.pointWidth,cA=an(cF)?(cG-cF)/2:cG*cx.pointPadding,cz=a0(cF,cG-2*cA),cE=(M?cK-(cC.columnIndex||0):cC.columnIndex)||0,cI=cA+(cH+cE*cG-(cy/2))*(M?-1:1);return(cC.columnMetrics={width:cz,offset:cI})},translate:function(){var cA=this,cD=cA.chart,cH=cA.options,L=cH.borderWidth,M=cA.yAxis,cC=cH.threshold,cG=cA.translatedThreshold=M.getThreshold(cC),cw=a0(cH.minPointLength,5),cE=cA.getColumnMetrics(),cz=cE.width,cF=cA.barW=aK(cu(cz,1+2*L)),cy=cA.pointXOffset=cE.offset,cx=-(L%2?0.5:0),cB=L%2?0.5:1;if(cD.renderer.isVML&&cD.inverted){cB+=1}bq.prototype.translate.apply(cA);I(cA.points,function(cO){var cL=a0(cO.yBottom,cG),cS=aw(cu(-999-cL,cO.plotY),M.len+999+cL),cI=cO.plotX+cy,cK=cF,cR=aw(cS,cL),cP,cJ,cQ,cN,cM=cu(cS,cL)-cR;if(f(cM)<cw){if(cw){cM=cw;cR=o(f(cR-cG)>cw?cL-cw:cG-(M.translate(cO.y,0,1,0,1)<=cG?cw:0))}}cO.barX=cI;cO.pointWidth=cz;cN=f(cI)<0.5;cP=o(cI+cK)+cx;cI=o(cI)+cx;cK=cP-cI;cQ=f(cR)<0.5;cJ=o(cR+cM)+cB;cR=o(cR)+cB;cM=cJ-cR;if(cN){cI+=1;cK-=1}if(cQ){cR-=1;cM+=1}cO.shapeType="rect";cO.shapeArgs={x:cI,y:cR,width:cK,height:cM}})},getSymbol:j,drawLegendSymbol:G.drawRectangle,drawGraph:j,drawPoints:function(){var cx=this,cy=this.chart,M=cx.options,cz=cy.renderer,L=M.animationLimit||250,cw;I(cx.points,function(cA){var cB=cA.plotY,cC=cA.graphic;if(cB!==k&&!isNaN(cB)&&cA.y!==null){cw=cA.shapeArgs;if(cC){bb(cC);cC[cx.points.length<L?"animate":"attr"](aY(cw))}else{cA.graphic=cC=cz[cA.shapeType](cw).attr(cA.pointAttr[cA.selected?bJ:au]).add(cx.group).shadow(M.shadow,null,M.stacking&&!M.borderRadius)}}else{if(cC){cA.graphic=cC.destroy()}}})},animate:function(cA){var cy=this,cw=this.yAxis,cx=cy.options,M=this.chart.inverted,L={},cz;if(cl){if(cA){L.scaleY=0.001;cz=aw(cw.pos+cw.len,cu(cw.pos,cw.toPixels(cx.threshold)));if(M){L.translateX=cz-cw.len}else{L.translateY=cz}cy.group.attr(L)}else{L.scaleY=1;L[M?"translateX":"translateY"]=cw.pos;cy.group.animate(L,cy.options.animation);cy.animate=null}}},remove:function(){var L=this,M=L.chart;if(M.hasRendered){I(M.series,function(cw){if(cw.type===L.type){cw.isDirty=true}})}bq.prototype.remove.apply(L,arguments)}});a.column=i;at.bar=aY(at.column);var bL=bA(i,{type:"bar",inverted:true});a.bar=bL;at.scatter=aY(a6,{lineWidth:0,tooltip:{headerFormat:'<span style="font-size: 10px; color:{series.color}">{series.name}</span><br/>',pointFormat:"x: <b>{point.x}</b><br/>y: <b>{point.y}</b><br/>",followPointer:true},stickyTracking:false});var bV=bA(bq,{type:"scatter",sorted:false,requireSorting:false,noSharedTooltip:true,trackerGroups:["markerGroup"],takeOrdinalPosition:false,singularTooltips:true,drawGraph:function(){if(this.options.lineWidth){bq.prototype.drawGraph.call(this)}}});a.scatter=bV;at.pie=aY(a6,{borderColor:"#FFFFFF",borderWidth:1,center:[null,null],clip:false,colorByPoint:true,dataLabels:{distance:30,enabled:true,formatter:function(){return this.point.name}},ignoreHiddenPoint:true,legendType:"point",marker:null,size:null,showInLegend:false,slicedOffset:10,states:{hover:{brightness:0.1,shadow:false}},stickyTracking:false,tooltip:{followPointer:true}});var a9=bA(bU,{init:function(){bU.prototype.init.apply(this,arguments);var L=this,M;if(L.y<0){L.y=null}bD(L,{visible:L.visible!==false,name:a0(L.name,"Slice")});M=function(cw){L.slice(cw.type==="select")};z(L,"select",M);z(L,"unselect",M);return L},setVisible:function(cx){var L=this,M=L.series,cw=M.chart;L.visible=L.options.visible=cx=cx===k?!L.visible:cx;M.options.data[A(L,M.data)]=L.options;I(["graphic","dataLabel","connector","shadowGroup"],function(cy){if(L[cy]){L[cy][cx?"show":"hide"](true)}});if(L.legendItem){cw.legend.colorizeItem(L,cx)}if(!M.isDirty&&M.options.ignoreHiddenPoint){M.isDirty=true;cw.redraw()}},slice:function(M,cA,cy){var L=this,cw=L.series,cx=cw.chart,cz;cq(cy,cx);cA=a0(cA,true);L.sliced=L.options.sliced=M=an(M)?M:!L.sliced;cw.options.data[A(L,cw.data)]=L.options;cz=M?L.slicedTranslation:{translateX:0,translateY:0};L.graphic.animate(cz);if(L.shadowGroup){L.shadowGroup.animate(cz)}}});var p={type:"pie",isCartesian:false,pointClass:a9,requireSorting:false,noSharedTooltip:true,trackerGroups:["group","dataLabelsGroup"],axisTypes:[],pointAttrToOptions:{stroke:"borderColor","stroke-width":"borderWidth",fill:"color"},singularTooltips:true,getColor:j,animate:function(cx){var M=this,cw=M.points,L=M.startAngleRad;if(!cx){I(cw,function(cy){var cA=cy.graphic,cz=cy.shapeArgs;if(cA){cA.attr({r:M.center[3]/2,start:L,end:L});cA.animate({r:cz.r,start:cz.start,end:cz.end},M.options.animation)}});M.animate=null}},setData:function(cw,cx,M,L){bq.prototype.setData.call(this,cw,false,M,L);this.processData();this.generatePoints();if(a0(cx,true)){this.chart.redraw(M)}},generatePoints:function(){var cx,cz=0,cy,cw,M,L=this.options.ignoreHiddenPoint;bq.prototype.generatePoints.call(this);cy=this.points;cw=cy.length;for(cx=0;cx<cw;cx++){M=cy[cx];cz+=(L&&!M.visible)?0:M.y}this.total=cz;for(cx=0;cx<cw;cx++){M=cy[cx];M.percentage=cz>0?(M.y/cz)*100:0;M.total=cz}},translate:function(cC){this.generatePoints();var cE=this,cG=0,cM=1000,M=cE.options,cx=M.slicedOffset,cD=cx+M.borderWidth,cy,cw,cN,cI=M.startAngle||0,cO=cE.startAngleRad=S/180*(cI-90),cP=cE.endAngleRad=S/180*((a0(M.endAngle,cI+360))-90),cF=cP-cO,cK=cE.points,cB,cA,cz=M.dataLabels.distance,L=M.ignoreHiddenPoint,cJ,cL=cK.length,cH;if(!cC){cE.center=cC=cE.getCenter()}cE.getX=function(cR,cQ){cN=a8.asin(aw((cR-cC[1])/(cC[2]/2+cz),1));return cC[0]+(cQ?-1:1)*(cm(cN)*(cC[2]/2+cz))};for(cJ=0;cJ<cL;cJ++){cH=cK[cJ];cy=cO+(cG*cF);if(!L||cH.visible){cG+=cH.percentage/100}cw=cO+(cG*cF);cH.shapeType="arc";cH.shapeArgs={x:cC[0],y:cC[1],r:cC[2]/2,innerR:cC[3]/2,start:o(cy*cM)/cM,end:o(cw*cM)/cM};cN=(cw+cy)/2;if(cN>1.5*S){cN-=2*S}else{if(cN<-S/2){cN+=2*S}}cH.slicedTranslation={translateX:o(cm(cN)*cx),translateY:o(ag(cN)*cx)};cB=cm(cN)*cC[2]/2;cA=ag(cN)*cC[2]/2;cH.tooltipPos=[cC[0]+cB*0.7,cC[1]+cA*0.7];cH.half=cN<-S/2||cN>S/2?1:0;cH.angle=cN;cD=aw(cD,cz/2);cH.labelPos=[cC[0]+cB+cm(cN)*cz,cC[1]+cA+ag(cN)*cz,cC[0]+cB+cm(cN)*cD,cC[1]+cA+ag(cN)*cD,cC[0]+cB,cC[1]+cA,cz<0?"center":cH.half?"right":"left",cN]}},drawGraph:null,drawPoints:function(){var cw=this,cx=cw.chart,cy=cx.renderer,cB,cA,cz=cw.options.shadow,L,M;if(cz&&!cw.shadowGroup){cw.shadowGroup=cy.g("shadow").add(cw.group)}I(cw.points,function(cC){cA=cC.graphic;M=cC.shapeArgs;L=cC.shadowGroup;if(cz&&!L){L=cC.shadowGroup=cy.g("shadow").add(cw.shadowGroup)}cB=cC.sliced?cC.slicedTranslation:{translateX:0,translateY:0};if(L){L.attr(cB)}if(cA){cA.animate(bD(M,cB))}else{cC.graphic=cA=cy[cC.shapeType](M).setRadialReference(cw.center).attr(cC.pointAttr[cC.selected?bJ:au]).attr({"stroke-linejoin":"round"}).attr(cB).add(cw.group).shadow(cz,L)}if(cC.visible!==undefined){cC.setVisible(cC.visible)}})},sortByAngle:function(M,L){M.sort(function(cx,cw){return cx.angle!==undefined&&(cw.angle-cx.angle)*L})},drawLegendSymbol:G.drawRectangle,getCenter:F.getCenter,getSymbol:j};p=bA(bq,p);a.pie=p;bq.prototype.drawDataLabels=function(){var M=this,L=M.options,cB=L.cursor,cC=L.dataLabels,cA=M.points,cw,cz,cy,cx;if(cC.enabled||M._hasPointLabels){if(M.dlProcessOptions){M.dlProcessOptions(cC)}cx=M.plotGroup("dataLabelsGroup","data-labels",M.visible?av:ap,cC.zIndex||6);cz=cC;I(cA,function(cJ){var cG,cL=cJ.dataLabel,cI,cH,cD,cK,cE=cJ.connector,cF=true;cw=cJ.options&&cJ.options.dataLabels;cG=a0(cw&&cw.enabled,cz.enabled);if(cL&&!cG){cJ.dataLabel=cL.destroy()}else{if(cG){cC=aY(cz,cw);cK=cC.rotation;cI=cJ.getLabelConfig();cy=cC.format?g(cC.format,cI):cC.formatter.call(cI,cC);cC.style.color=a0(cC.color,cC.style.color,M.color,"black");if(cL){if(an(cy)){cL.attr({text:cy});cF=false}else{cJ.dataLabel=cL=cL.destroy();if(cE){cJ.connector=cE.destroy()}}}else{if(an(cy)){cH={fill:cC.backgroundColor,stroke:cC.borderColor,"stroke-width":cC.borderWidth,r:cC.borderRadius||0,rotation:cK,padding:cC.padding,zIndex:1};for(cD in cH){if(cH[cD]===k){delete cH[cD]}}cL=cJ.dataLabel=M.chart.renderer[cK?"text":"label"](cy,0,-999,null,null,null,cC.useHTML).attr(cH).css(bD(cC.style,cB&&{cursor:cB})).add(cx).shadow(cC.shadow)}}if(cL){M.alignDataLabel(cJ,cL,cC,null,cF)}}}})}};bq.prototype.alignDataLabel=function(cB,cE,cF,cz,cy){var cA=this.chart,cw=cA.inverted,L=a0(cB.plotX,-999),cD=a0(cB.plotY,-999),cC=cE.getBBox(),M=this.visible&&(cB.series.forceDL||cA.isInsidePlot(L,o(cD),cw)||(cz&&cA.isInsidePlot(L,cw?cz.x+1:cz.y+cz.height-1,cw))),cx;if(M){cz=bD({x:cw?cA.plotWidth-cD:L,y:o(cw?cA.plotHeight-L:cD),width:0,height:0},cz);bD(cF,{width:cC.width,height:cC.height});if(cF.rotation){cx={align:cF.align,x:cz.x+cF.x+cz.width/2,y:cz.y+cF.y+cz.height/2};cE[cy?"attr":"animate"](cx)}else{cE.align(cF,null,cz);cx=cE.alignAttr;if(a0(cF.overflow,"justify")==="justify"){this.justifyDataLabel(cE,cF,cx,cC,cz,cy)}else{if(a0(cF.crop,true)){M=cA.isInsidePlot(cx.x,cx.y)&&cA.isInsidePlot(cx.x+cC.width,cx.y+cC.height)}}}}if(!M){cE.attr({y:-999});cE.placed=false}};bq.prototype.justifyDataLabel=function(cD,cE,cx,cC,cA,cy){var cB=this.chart,cz=cE.align,M=cE.verticalAlign,L,cw;L=cx.x;if(L<0){if(cz==="right"){cE.align="left"}else{cE.x=-L}cw=true}L=cx.x+cC.width;if(L>cB.plotWidth){if(cz==="left"){cE.align="right"}else{cE.x=cB.plotWidth-L}cw=true}L=cx.y;if(L<0){if(M==="bottom"){cE.verticalAlign="top"}else{cE.y=-L}cw=true}L=cx.y+cC.height;if(L>cB.plotHeight){if(M==="top"){cE.verticalAlign="bottom"}else{cE.y=cB.plotHeight-L}cw=true}if(cw){cD.placed=!cy;cD.align(cE,null,cA)}};if(a.pie){a.pie.prototype.drawDataLabels=function(){var cB=this,c6=cB.data,cU,c7=cB.chart,cR=cB.options.dataLabels,cy=a0(cR.connectorPadding,10),cP=a0(cR.connectorWidth,1),cx=c7.plotWidth,cZ=c7.plotHeight,L,c3,cQ=a0(cR.softConnector,true),cI=cR.distance,cA=cB.center,c0=cA[2]/2,M=cA[1],cF=cI>0,cz,cH,cG,cY,cT=[[],[]],cX,cW,cL,cD,c4,c2,c1=[0,0,0,0],c5=function(db,da){return da.y-db.y};if(!cB.visible||(!cR.enabled&&!cB._hasPointLabels)){return}bq.prototype.drawDataLabels.apply(cB);I(c6,function(da){if(da.dataLabel&&da.visible){cT[da.half].push(da)}});c4=0;while(!cY&&c6[c4]){cY=c6[c4]&&c6[c4].dataLabel&&(c6[c4].dataLabel.getBBox().height||21);c4++}c4=2;while(c4--){var c8=[],cC,cN=[],cV=cT[c4],cS,cK=cV.length,c9;cB.sortByAngle(cV,c4-0.5);if(cI>0){for(cS=M-c0-cI;cS<=M+c0+cI;cS+=cY){c8.push(cS)}cC=c8.length;if(cK>cC){cD=[].concat(cV);cD.sort(c5);c2=cK;while(c2--){cD[c2].rank=c2}c2=cK;while(c2--){if(cV[c2].rank>=cC){cV.splice(c2,1)}}cK=cV.length}for(c2=0;c2<cK;c2++){cU=cV[c2];cG=cU.labelPos;var cJ=9999,cO,cM;for(cM=0;cM<cC;cM++){cO=f(c8[cM]-cG[1]);if(cO<cJ){cJ=cO;c9=cM}}if(c9<c2&&c8[c2]!==null){c9=c2}else{if(cC<cK-c2+c9&&c8[c2]!==null){c9=cC-cK+c2;while(c8[c9]===null){c9++}}else{while(c8[c9]===null){c9++}}}cN.push({i:c9,y:c8[c9]});c8[c9]=null}cN.sort(c5)}for(c2=0;c2<cK;c2++){var cE,cw;cU=cV[c2];cG=cU.labelPos;cz=cU.dataLabel;cL=cU.visible===false?ap:av;cw=cG[1];if(cI>0){cE=cN.pop();c9=cE.i;cW=cE.y;if((cw>cW&&c8[c9+1]!==null)||(cw<cW&&c8[c9-1]!==null)){cW=cw}}else{cW=cw}cX=cR.justify?cA[0]+(c4?-1:1)*(c0+cI):cB.getX(c9===0||c9===c8.length-1?cw:cW,c4);cz._attr={visibility:cL,align:cG[6]};cz._pos={x:cX+cR.x+({left:cy,right:-cy}[cG[6]]||0),y:cW+cR.y-10};cz.connX=cX;cz.connY=cW;if(this.options.size===null){cH=cz.width;if(cX-cH<cy){c1[3]=cu(o(cH-cX+cy),c1[3])}else{if(cX+cH>cx-cy){c1[1]=cu(o(cX+cH-cx+cy),c1[1])}}if(cW-cY/2<0){c1[0]=cu(o(-cW+cY/2),c1[0])}else{if(cW+cY/2>cZ){c1[2]=cu(o(cW+cY/2-cZ),c1[2])}}}}}if(aS(c1)===0||this.verifyDataLabelOverflow(c1)){this.placeDataLabels();if(cF&&cP){I(this.points,function(da){L=da.connector;cG=da.labelPos;cz=da.dataLabel;if(cz&&cz._pos){cL=cz._attr.visibility;cX=cz.connX;cW=cz.connY;c3=cQ?[bN,cX+(cG[6]==="left"?5:-5),cW,"C",cX,cW,2*cG[2]-cG[4],2*cG[3]-cG[5],cG[2],cG[3],bO,cG[4],cG[5]]:[bN,cX+(cG[6]==="left"?5:-5),cW,bO,cG[2],cG[3],bO,cG[4],cG[5]];if(L){L.animate({d:c3});L.attr("visibility",cL)}else{da.connector=L=cB.chart.renderer.path(c3).attr({"stroke-width":cP,stroke:cR.connectorColor||da.color||"#606060",visibility:cL}).add(cB.group)}}else{if(L){da.connector=L.destroy()}}})}}};a.pie.prototype.placeDataLabels=function(){I(this.points,function(M){var cw=M.dataLabel,L;if(cw){L=cw._pos;if(L){cw.attr(cw._attr);cw[cw.moved?"animate":"attr"](L);cw.moved=true}else{if(cw){cw.attr({y:-999})}}}})};a.pie.prototype.alignDataLabel=j;a.pie.prototype.verifyDataLabelOverflow=function(cA){var L=this.center,cx=this.options,cy=cx.center,cz=cx.minSize||80,M=cz,cw;if(cy[0]!==null){M=cu(L[2]-cu(cA[1],cA[3]),cz)}else{M=cu(L[2]-cA[1]-cA[3],cz);L[0]+=(cA[3]-cA[1])/2}if(cy[1]!==null){M=cu(aw(M,L[2]-cu(cA[0],cA[2])),cz)}else{M=cu(aw(M,L[2]-cA[0]-cA[2]),cz);L[1]+=(cA[0]-cA[2])/2}if(M<L[2]){L[2]=M;this.translate(L);I(this.points,function(cB){if(cB.dataLabel){cB.dataLabel._pos=null}});if(this.drawDataLabels){this.drawDataLabels()}}else{cw=true}return cw}}if(a.column){a.column.prototype.alignDataLabel=function(cB,cC,cD,cx,cw){var cy=this.chart,M=cy.inverted,cz=cB.dlBox||cB.shapeArgs,cA=cB.below||(cB.plotY>a0(this.translatedThreshold,cy.plotSizeY)),L=a0(cD.inside,!!this.options.stacking);if(cz){cx=aY(cz);if(M){cx={x:cy.plotWidth-cx.y-cx.height,y:cy.plotHeight-cx.x-cx.width,width:cx.height,height:cx.width}}if(!L){if(M){cx.x+=cA?0:cx.width;cx.width=0}else{cx.y+=cA?cx.height:0;cx.height=0}}}cD.align=a0(cD.align,!M||L?"center":cA?"right":"left");cD.verticalAlign=a0(cD.verticalAlign,M||L?"middle":cA?"top":"bottom");bq.prototype.alignDataLabel.call(this,cB,cC,cD,cx,cw)}}var aU=aZ.TrackerMixin={drawTrackerPoint:function(){var M=this,cw=M.chart,cz=cw.pointer,cy=M.options.cursor,L=cy&&{cursor:cy},cx=function(cC){var cB=cC.target,cA;if(cw.hoverSeries!==M){M.onMouseOver()}while(cB&&!cA){cA=cB.point;cB=cB.parentNode}if(cA!==k&&cA!==cw.hoverPoint){cA.onMouseOver(cC)}};I(M.points,function(cA){if(cA.graphic){cA.graphic.element.point=cA}if(cA.dataLabel){cA.dataLabel.element.point=cA}});if(!M._hasTracking){I(M.trackerGroups,function(cA){if(M[cA]){M[cA].addClass(bk+"tracker").on("mouseover",cx).on("mouseout",function(cB){cz.onTrackerMouseOut(cB)}).css(L);if(H){M[cA].on("touchstart",cx)}}});M._hasTracking=true}},drawTrackerGraph:function(){var cB=this,cK=cB.options,cJ=cK.trackByArea,M=[].concat(cJ?cB.areaPath:cB.graphPath),cG=M.length,cF=cB.chart,L=cF.pointer,cE=cF.renderer,cx=cF.options.tooltip.snap,cH=cB.tracker,cI=cK.cursor,cD=cI&&{cursor:cI},cA=cB.singlePoints,cy,cz,cC=function(){if(cF.hoverSeries!==cB){cB.onMouseOver()}},cw="rgba(192,192,192,"+(cl?0.0001:0.002)+")";if(cG&&!cJ){cz=cG+1;while(cz--){if(M[cz]===bN){M.splice(cz+1,0,M[cz+1]-cx,M[cz+2],bO)}if((cz&&M[cz]===bN)||cz===cG){M.splice(cz,0,bO,M[cz-2]+cx,M[cz-1])}}}for(cz=0;cz<cA.length;cz++){cy=cA[cz];M.push(bN,cy.plotX-cx,cy.plotY,bO,cy.plotX+cx,cy.plotY)}if(cH){cH.attr({d:M})}else{cB.tracker=cE.path(M).attr({"stroke-linejoin":"round",visibility:cB.visible?av:ap,stroke:cw,fill:cJ?cw:B,"stroke-width":cK.lineWidth+(cJ?0:2*cx),zIndex:2}).add(cB.group);I([cB.tracker,cB.markerGroup],function(cL){cL.addClass(bk+"tracker").on("mouseover",cC).on("mouseout",function(cM){L.onTrackerMouseOut(cM)}).css(cD);if(H){cL.on("touchstart",cC)}})}}};if(a.column){i.prototype.drawTracker=aU.drawTrackerPoint}if(a.pie){a.pie.prototype.drawTracker=aU.drawTrackerPoint}if(a.scatter){bV.prototype.drawTracker=aU.drawTrackerPoint}bD(bP.prototype,{setItemEvents:function(cx,L,cz,cy,M){var cw=this;(cz?L:cx.legendGroup).on("mouseover",function(){cx.setState(a2);L.css(cw.options.itemHoverStyle)}).on("mouseout",function(){L.css(cx.visible?cy:M);cx.setState()}).on("click",function(cB){var cC="legendItemClick",cA=function(){cx.setVisible()};cB={browserEvent:cB};if(cx.firePointEvent){cx.firePointEvent(cC,cB,cA)}else{bM(cx,cC,cB,cA)}})},createCheckboxForItem:function(M){var L=this;M.checkbox=bF("input",{type:"checkbox",checked:M.selected,defaultChecked:M.selected},L.options.itemCheckboxStyle,L.chart.container);z(M.checkbox,"click",function(cw){var cx=cw.target;bM(M,"checkboxClick",{checked:cx.checked},function(){M.select()})})}});bS.legend.itemStyle.cursor="pointer";bD(bB.prototype,{showResetZoom:function(){var cw=this,cz=bS.lang,M=cw.options.chart.resetZoomButton,cy=M.theme,L=cy.states,cx=M.relativeTo==="chart"?null:"plotBox";this.resetZoomButton=cw.renderer.button(cz.resetZoom,null,null,function(){cw.zoomOut()},cy,L&&L.hover).attr({align:M.position.align,title:cz.resetZoomTitle}).add().align(M.position,false,cx)},zoomOut:function(){var L=this;bM(L,"selection",{resetSelection:true},function(){L.zoom()})},zoom:function(cw){var M=this,L,cz=M.pointer,cy=false,cx;if(!cw||cw.resetSelection){I(M.axes,function(cA){L=cA.zoom()})}else{I(cw.xAxis.concat(cw.yAxis),function(cA){var cB=cA.axis,cC=cB.isXAxis;if(cz[cC?"zoomX":"zoomY"]||cz[cC?"pinchX":"pinchY"]){L=cB.zoom(cA.min,cA.max);if(cB.displayBtn){cy=true}}})}cx=M.resetZoomButton;if(cy&&!cx){M.showResetZoom()}else{if(!cy&&cr(cx)){M.resetZoomButton=cx.destroy()}}if(L){M.redraw(a0(M.options.chart.animation,cw&&cw.animation,M.pointCount<100))}},pan:function(cx,cw){var M=this,L=M.hoverPoints,cy;if(L){I(L,function(cz){cz.setState()})}I(cw==="xy"?[1,0]:[1],function(cE){var cz=cx[cE?"chartX":"chartY"],cD=M[cE?"xAxis":"yAxis"][0],cB=M[cE?"mouseDownX":"mouseDownY"],cA=(cD.pointRange||0)/2,cG=cD.getExtremes(),cF=cD.toValue(cB-cz,true)+cA,cC=cD.toValue(cB+M[cE?"plotWidth":"plotHeight"]-cz,true)-cA;if(cD.series.length&&cF>aw(cG.dataMin,cG.min)&&cC<cu(cG.dataMax,cG.max)){cD.setExtremes(cF,cC,false,false,{trigger:"pan"});cy=true}M[cE?"mouseDownX":"mouseDownY"]=cz});if(cy){M.redraw(false)}cp(M.container,{cursor:"move"})}});bD(bU.prototype,{select:function(cy,M){var L=this,cw=L.series,cx=cw.chart;cy=a0(cy,!L.selected);L.firePointEvent(cy?"select":"unselect",{accumulate:M},function(){L.selected=L.options.selected=cy;cw.options.data[A(L,cw.data)]=L.options;L.setState(cy&&bJ);if(!M){I(cx.getSelectedPoints(),function(cz){if(cz.selected&&cz!==L){cz.selected=cz.options.selected=false;cw.options.data[A(cz,cw.data)]=cz.options;cz.setState(au);cz.firePointEvent("unselect")}})}})},onMouseOver:function(cz){var L=this,cw=L.series,cx=cw.chart,cy=cx.tooltip,M=cx.hoverPoint;if(M&&M!==L){M.onMouseOut()}L.firePointEvent("mouseOver");if(cy&&(!cy.shared||cw.noSharedTooltip)){cy.refresh(L,cz)}L.setState(a2);cx.hoverPoint=L},onMouseOut:function(){var M=this.series.chart,L=M.hoverPoints;if(!L||A(this,L)===-1){this.firePointEvent("mouseOut");this.setState();M.hoverPoint=null}},firePointEvent:function(cz,cx,M){var L=this,cy=this.series,cw=cy.options;if(cw.point.events[cz]||(L.options&&L.options.events&&L.options.events[cz])){this.importEvents()}if(cz==="click"&&cw.allowPointSelect){M=function(cA){L.select(null,cA.ctrlKey||cA.metaKey||cA.shiftKey)}}bM(this,cz,cx,M)},importEvents:function(){if(!this.hasImportedEvents){var L=this,M=aY(L.series.options.point,L.options),cx=M.events,cw;L.events=cx;for(cw in cx){z(L,cw,cx[cw])}this.hasImportedEvents=true}},setState:function(cw,cz){var cI=this,M=cI.plotX,cK=cI.plotY,cC=cI.series,cJ=cC.options.states,cx=at[cC.type].marker&&cC.options.marker,cA=cx&&!cx.enabled,cy=cx&&cx.states[cw],cE=cy&&cy.enabled===false,cH=cC.stateMarkerGraphic,cF=cI.marker||{},cG=cC.chart,cD,cB,L=cI.pointAttr;cw=cw||au;cz=cz&&cH;if((cw===cI.state&&!cz)||(cI.selected&&cw!==bJ)||(cJ[cw]&&cJ[cw].enabled===false)||(cw&&(cE||(cA&&!cy.enabled)))||(cw&&cF.states&&cF.states[cw]&&cF.states[cw].enabled===false)){return}if(cI.graphic){cD=cx&&cI.graphic.symbolName&&L[cw].r;cI.graphic.attr(aY(L[cw],cD?{x:M-cD,y:cK-cD,width:2*cD,height:2*cD}:{}))}else{if(cw&&cy){cD=cy.radius;cB=cF.symbol||cC.symbol;if(cH&&cH.currentSymbol!==cB){cH=cH.destroy()}if(!cH){cC.stateMarkerGraphic=cH=cG.renderer.symbol(cB,M-cD,cK-cD,2*cD,2*cD).attr(L[cw]).add(cC.markerGroup);cH.currentSymbol=cB}else{cH[cz?"animate":"attr"]({x:M-cD,y:cK-cD})}}if(cH){cH[cw&&cG.isInsidePlot(M,cK,cG.inverted)?"show":"hide"]()}}cI.state=cw}});bD(bq.prototype,{onMouseOver:function(){var M=this,cw=M.chart,L=cw.hoverSeries;if(L&&L!==M){L.onMouseOut()}if(M.options.events.mouseOver){bM(M,"mouseOver")}M.setState(a2);cw.hoverSeries=M},onMouseOut:function(){var cw=this,M=cw.options,cx=cw.chart,cy=cx.tooltip,L=cx.hoverPoint;if(L){L.onMouseOut()}if(cw&&M.events.mouseOut){bM(cw,"mouseOut")}if(cy&&!M.stickyTracking&&(!cy.shared||cw.noSharedTooltip)){cy.hide()}cw.setState();cx.hoverSeries=null},setState:function(cz){var cw=this,M=cw.options,cy=cw.graph,cx=cw.graphNeg,cA=M.states,L=M.lineWidth,cB;cz=cz||au;if(cw.state!==cz){cw.state=cz;if(cA[cz]&&cA[cz].enabled===false){return}if(cz){L=cA[cz].lineWidth||L+1}if(cy&&!cy.dashstyle){cB={"stroke-width":L};cy.attr(cB);if(cx){cx.attr(cB)}}}},setVisible:function(cz,cB){var cx=this,cy=cx.chart,M=cx.legendItem,L,cA=cy.options.chart.ignoreHiddenSeries,cw=cx.visible;cx.visible=cz=cx.userOptions.visible=cz===k?!cw:cz;L=cz?"show":"hide";I(["group","dataLabelsGroup","markerGroup","tracker"],function(cC){if(cx[cC]){cx[cC][L]()}});if(cy.hoverSeries===cx){cx.onMouseOut()}if(M){cy.legend.colorizeItem(cx,cz)}cx.isDirty=true;if(cx.options.stacking){I(cy.series,function(cC){if(cC.options.stacking&&cC.visible){cC.isDirty=true}})}I(cx.linkedSeries,function(cC){cC.setVisible(cz,false)});if(cA){cy.isDirtyBox=true}if(cB!==false){cy.redraw()}bM(cx,L)},setTooltipPoints:function(cy){var cA=this,cH=[],cF,cD,cx,cw=cA.xAxis,cC=cw&&cw.getExtremes(),cB=cw?(cw.tooltipLen||cw.len):cA.chart.plotSizeX,cG,L,cE,cz,M=[];if(cA.options.enableMouseTracking===false||cA.singularTooltips){return}if(cy){cA.tooltipPoints=null}I(cA.segments||cA.points,function(cI){cH=cH.concat(cI)});if(cw&&cw.reversed){cH=cH.reverse()}if(cA.orderTooltipPoints){cA.orderTooltipPoints(cH)}cF=cH.length;for(cz=0;cz<cF;cz++){cG=cH[cz];L=cG.x;if(L>=cC.min&&L<=cC.max){cE=cH[cz+1];cD=cx===k?0:cx+1;cx=cH[cz+1]?aw(cu(0,bE((cG.clientX+(cE?(cE.wrappedClientX||cE.clientX):cB))/2)),cB):cB;while(cD>=0&&cD<=cx){M[cD++]=cG}}}cA.tooltipPoints=M},show:function(){this.setVisible(true)},hide:function(){this.setVisible(false)},select:function(M){var L=this;L.selected=M=(M===k)?!L.selected:M;if(L.checkbox){L.checkbox.checked=M}bM(L,M?"select":"unselect")},drawTracker:aU.drawTrackerGraph});bc(bq.prototype,"init",function(M){var L=this,cw;M.apply(this,Array.prototype.slice.call(arguments,1));cw=L.xAxis;if(cw&&cw.options.ordinal){z(L,"updatedData",function(){delete cw.ordinalIndex})}});bc(C.prototype,"getTimeTicks",function(cx,M,cL,cO,cT,cG,cS,cD){var cB=0,cA=0,L,cP={},cU,cR,cV,cQ,cw=[],cE=-Number.MAX_VALUE,cH=this.options.tickPixelInterval;if(!this.options.ordinal||!cG||cG.length<3||cL===k){return cx.call(this,M,cL,cO,cT)}cV=cG.length;for(;cA<cV;cA++){cQ=cA&&cG[cA-1]>cO;if(cG[cA]<cL){cB=cA}if(cA===cV-1||cG[cA+1]-cG[cA]>cS*5||cQ){if(cG[cA]>cE){L=cx.call(this,M,cG[cB],cG[cA],cT);while(L.length&&L[0]<=cE){L.shift()}if(L.length){cE=L[L.length-1]}cw=cw.concat(L)}cB=cA+1}if(cQ){break}}cR=L.info;if(cD&&cR.unitRange<=bg[Z]){cA=cw.length-1;for(cB=1;cB<cA;cB++){if(new Date(cw[cB]-bz)[bC]()!==new Date(cw[cB-1]-bz)[bC]()){cP[cw[cB]]=b5;cU=true}}if(cU){cP[cw[0]]=b5}cR.higherRanks=cP}cw.info=cR;if(cD&&an(cH)){var cz=cw.length,cN=cz,cK,cM,cJ=[],cI,cF,cy,cC=[];while(cN--){cM=this.translate(cw[cN]);if(cI){cC[cN]=cI-cM}cJ[cN]=cI=cM}cC.sort();cF=cC[bE(cC.length/2)];if(cF<cH*0.6){cF=null}cN=cw[cz-1]>cO?cz-1:cz;cI=undefined;while(cN--){cM=cJ[cN];cy=cI-cM;if(cI&&cy<cH*0.8&&(cF===null||cy<cF*0.8)){if(cP[cw[cN]]&&!cP[cw[cN+1]]){cK=cN+1;cI=cM}else{cK=cN}cw.splice(cK,1)}else{cI=cM}}}return cw});bD(C.prototype,{beforeSetTickPositions:function(){var M=this,cA,L=[],cE=false,cC,cF=M.getExtremes(),cx=cF.min,cD=cF.max,cz,cw,cB,cy;if(M.options.ordinal){I(M.series,function(cH,cG){if(cH.visible!==false&&cH.takeOrdinalPosition!==false){L=L.concat(cH.processedXData);cA=L.length;L.sort(function(cJ,cI){return cJ-cI});if(cA){cG=cA-1;while(cG--){if(L[cG]===L[cG+1]){L.splice(cG,1)}}}}});cA=L.length;if(cA>2){cC=L[1]-L[0];cy=cA-1;while(cy--&&!cE){if(L[cy+1]-L[cy]!==cC){cE=true}}if(!M.options.keepOrdinalPadding&&(L[0]-cx>cC||cD-L[L.length-1]>cC)){cE=true}}if(cE){M.ordinalPositions=L;cz=M.val2lin(cu(cx,L[0]),true);cw=M.val2lin(aw(cD,L[L.length-1]),true);M.ordinalSlope=cB=(cD-cx)/(cw-cz);M.ordinalOffset=cx-(cz*cB)}else{M.ordinalPositions=M.ordinalSlope=M.ordinalOffset=k}}M.groupIntervalFactor=null},val2lin:function(cz,cy){var M=this,cw=M.ordinalPositions;if(!cw){return cz}else{var cx=cw.length,L;L=ai(cw,cz);return cy?L:M.ordinalSlope*(L||0)+M.ordinalOffset}},lin2val:function(cx,cD){var cy=this,L=cy.ordinalPositions;if(!L){return cx}else{var cz=cy.ordinalSlope,cA=cy.ordinalOffset,cB=L.length-1,cC,cw,M;if(cD){if(cx<0){cx=L[0]}else{if(cx>cB){cx=L[cB]}else{cB=bE(cx);M=cx-cB}}}else{while(cB--){cC=(cz*cB)+cA;if(cx>=cC){cw=(cz*(cB+1))+cA;M=(cx-cC)/(cw-cC);break}}}return M!==k&&L[cB]!==k?L[cB]+(M?M*(L[cB+1]-L[cB]):0):cx}},getExtendedPositions:function(){var cz=this,cy=cz.chart,cA=cz.series[0].currentDataGrouping,cw=cz.ordinalIndex,cx=cA?cA.count+cA.unitName:"raw",cB=cz.getExtremes(),M,L;if(!cw){cw=cz.ordinalIndex={}}if(!cw[cx]){M={series:[],getExtremes:function(){return{min:cB.dataMin,max:cB.dataMax}},options:{ordinal:true},val2lin:C.prototype.val2lin};I(cz.series,function(cC){L={xAxis:M,xData:cC.xData,chart:cy,destroyGroupedData:j};L.options={dataGrouping:cA?{enabled:true,forced:true,approximation:"open",units:[[cA.unitName,[cA.count]]]}:{enabled:false}};cC.processData.apply(L);M.series.push(L)});cz.beforeSetTickPositions.apply(M);cw[cx]=M.ordinalPositions}return cw[cx]},getGroupIntervalFactor:function(M,cy,cw){var cx=0,cB=cw.processedXData,cz=cB.length,cA=[],cC,L=this.groupIntervalFactor;if(!L){for(;cx<cz-1;cx++){cA[cx]=cB[cx+1]-cB[cx]}cA.sort(function(cE,cD){return cE-cD});cC=cA[bE(cz/2)];M=cu(M,cB[0]);cy=aw(cy,cB[cz-1]);this.groupIntervalFactor=L=(cz*cC)/(cy-M)}return L},postProcessTickInterval:function(M){var L=this.ordinalSlope;return L?M/(L/this.closestPointRange):M}});bc(bB.prototype,"pan",function(cx,cM){var cG=this,cC=cG.xAxis[0],cB=cM.chartX,cN=false;if(cC.options.ordinal&&cC.series.length){var cK=cG.mouseDownX,L=cC.getExtremes(),cP=L.dataMax,cJ=L.min,cL=L.max,cF,cD=cG.hoverPoints,M=cC.closestPointRange,cA=cC.translationSlope*(cC.ordinalSlope||M),cw=(cK-cB)/cA,cI={ordinalPositions:cC.getExtendedPositions()},cy,cz,cH=cC.lin2val,cO=cC.val2lin,cE;if(!cI.ordinalPositions){cN=true}else{if(f(cw)>1){if(cD){I(cD,function(cQ){cQ.setState()})}if(cw<0){cz=cI;cE=cC.ordinalPositions?cC:cI}else{cz=cC.ordinalPositions?cC:cI;cE=cI}cy=cE.ordinalPositions;if(cP>cy[cy.length-1]){cy.push(cP)}cG.fixedRange=cL-cJ;cF=cC.toFixedRange(null,null,cH.apply(cz,[cO.apply(cz,[cJ,true])+cw,true]),cH.apply(cE,[cO.apply(cE,[cL,true])+cw,true]));if(cF.min>=aw(L.dataMin,cJ)&&cF.max<=cu(cP,cL)){cC.setExtremes(cF.min,cF.max,true,false,{trigger:"pan"})}cG.mouseDownX=cB;cp(cG.container,{cursor:"move"})}}}else{cN=true}if(cN){cx.apply(this,Array.prototype.slice.call(arguments,1))}});bc(bq.prototype,"getSegments",function(cw){var M=this,L,cy=M.options.gapSize,cx=M.xAxis;cw.apply(this,Array.prototype.slice.call(arguments,1));if(cy){L=M.segments;I(L,function(cA,cB){var cz=cA.length-1;while(cz--){if(cA[cz+1].x-cA[cz].x>cx.closestPointRange*cy){L.splice(cB+1,0,cA.splice(cz+1,cA.length-cz))}}})}});var ce="dataGrouping",cc=bq.prototype,s=cg.prototype,bT=cc.processData,l=cc.generatePoints,ci=cc.destroy,aW=s.tooltipHeaderFormatter,aB="number",h={approximation:"average",groupPixelWidth:2,dateTimeLabelFormats:a7(ck,["%A, %b %e, %H:%M:%S.%L","%A, %b %e, %H:%M:%S.%L","-%H:%M:%S.%L"],by,["%A, %b %e, %H:%M:%S","%A, %b %e, %H:%M:%S","-%H:%M:%S"],b3,["%A, %b %e, %H:%M","%A, %b %e, %H:%M","-%H:%M"],Z,["%A, %b %e, %H:%M","%A, %b %e, %H:%M","-%H:%M"],b5,["%A, %b %e, %Y","%A, %b %e","-%A, %b %e, %Y"],ch,["Week from %A, %b %e, %Y","%A, %b %e","-%A, %b %e, %Y"],bx,["%B %Y","%B","-%B %Y"],bu,["%Y","%Y","-%Y"])},a1={line:{},spline:{},area:{},areaspline:{},column:{approximation:"sum",groupPixelWidth:10},arearange:{approximation:"range"},areasplinerange:{approximation:"range"},columnrange:{approximation:"range",groupPixelWidth:10},candlestick:{approximation:"ohlc",groupPixelWidth:10},ohlc:{approximation:"ohlc",groupPixelWidth:5}},co=[[ck,[1,2,5,10,20,25,50,100,200,500]],[by,[1,2,5,10,15,30]],[b3,[1,2,5,10,15,30]],[Z,[1,2,3,4,6,8,12]],[b5,[1]],[ch,[1]],[bx,[1,3,6]],[bu,null]],bm={sum:function(M){var L=M.length,cw;if(!L&&M.hasNulls){cw=null}else{if(L){cw=0;while(L--){cw+=M[L]}}}return cw},average:function(M){var L=M.length,cw=bm.sum(M);if(typeof cw===aB&&L){cw=cw/L}return cw},open:function(L){return L.length?L[0]:(L.hasNulls?null:k)},high:function(L){return L.length?aS(L):(L.hasNulls?null:k)},low:function(L){return L.length?bY(L):(L.hasNulls?null:k)},close:function(L){return L.length?L[L.length-1]:(L.hasNulls?null:k)},ohlc:function(M,cw,L,cx){M=bm.open(M);cw=bm.high(cw);L=bm.low(L);cx=bm.close(cx);if(typeof M===aB||typeof cw===aB||typeof L===aB||typeof cx===aB){return[M,cw,L,cx]}},range:function(L,M){L=bm.low(L);M=bm.high(M);if(typeof L===aB||typeof M===aB){return[L,M]}}};cc.groupData=function(cw,cN,M,cG){var cB=this,cP=cB.data,cC=cB.options.data,cM=[],cD=[],cA=cw.length,cz,cy,cF,cE=!!cN,L=[[],[],[],[]],cK=typeof cG==="function"?cG:bm[cG],cH=cB.pointArrayMap,cO=cH&&cH.length,cL;for(cL=0;cL<=cA;cL++){if(cw[cL]>=M[0]){break}}for(;cL<=cA;cL++){while((M[1]!==k&&cw[cL]>=M[1])||cL===cA){cz=M.shift();cF=cK.apply(0,L);if(cF!==k){cM.push(cz);cD.push(cF)}L[0]=[];L[1]=[];L[2]=[];L[3]=[];if(cL===cA){break}}if(cL===cA){break}if(cH){var cx=cB.cropStart+cL,cI=(cP&&cP[cx])||cB.pointClass.prototype.applyOptions.apply({series:cB},[cC[cx]]),cJ,cQ;for(cJ=0;cJ<cO;cJ++){cQ=cI[cH[cJ]];if(typeof cQ===aB){L[cJ].push(cQ)}else{if(cQ===null){L[cJ].hasNulls=true}}}}else{cy=cE?cN[cL]:null;if(typeof cy===aB){L[0].push(cy)}else{if(cy===null){L[0].hasNulls=true}}}}return[cM,cD]};cc.processData=function(){var cF=this,cH=cF.chart,cy=cF.options,cz=cy[ce],cJ=cz&&a0(cz.enabled,cH.options._stock),cw;cF.forceCrop=cJ;cF.groupPixelWidth=null;cF.hasProcessed=true;if(bT.apply(cF,arguments)===false||!cJ){return}else{cF.destroyGroupedData()}var cL,cC=cF.processedXData,cQ=cF.processedYData,cB=cH.plotSizeX,cD=cF.xAxis,cK=cD.options.ordinal,cA=cF.groupPixelWidth=cD.getGroupPixelWidth&&cD.getGroupPixelWidth(),cI=cF.pointRange;if(cA){cw=true;cF.points=null;var L=cD.getExtremes(),cO=L.min,cP=L.max,cE=(cK&&cD.getGroupIntervalFactor(cO,cP,cF))||1,cN=(cA*(cP-cO)/cB)*cE,cx=cD.getTimeTicks(cD.normalizeTimeTickInterval(cN,cz.units||co),cO,cP,null,cC,cF.closestPointRange),M=cc.groupData.apply(cF,[cC,cQ,cx,cz.approximation]),cM=M[0],cG=M[1];if(cz.smoothed){cL=cM.length-1;cM[cL]=cP;while(cL--&&cL>0){cM[cL]+=cN/2}cM[0]=cO}cF.currentDataGrouping=cx.info;if(cy.pointRange===null){cF.pointRange=cx.info.totalRange}cF.closestPointRange=cx.info.totalRange;if(an(cM[0])&&cM[0]<cD.dataMin){cD.dataMin=cM[0]}cF.processedXData=cM;cF.processedYData=cG}else{cF.currentDataGrouping=null;cF.pointRange=cI}cF.hasGroupedData=cw};cc.destroyGroupedData=function(){var L=this.groupedData;I(L||[],function(M,cw){if(M){L[cw]=M.destroy?M.destroy():null}});this.groupedData=null};cc.generatePoints=function(){l.apply(this);this.destroyGroupedData();this.groupedData=this.hasGroupedData?this.points:null};s.tooltipHeaderFormatter=function(cF){var cH=this,cC=cF.series,cI=cC.options,cy=cC.tooltipOptions,cz=cI.dataGrouping,cA=cy.xDateFormat,cG,M=cC.xAxis,L,cD,cx,cB,cw,cE;if(M&&M.options.type==="datetime"&&cz&&aD(cF.key)){L=cC.currentDataGrouping;cD=cz.dateTimeLabelFormats;if(L){cx=cD[L.unitName];if(L.count===1){cA=cx[0]}else{cA=cx[1];cG=cx[2]}}else{if(!cA&&cD){for(cw in bg){if(bg[cw]>=M.closestPointRange||(bg[cw]<=bg[b5]&&cF.key%bg[cw]>0)){cA=cD[cw][0];break}}}}cB=cb(cA,cF.key);if(cG){cB+=cb(cG,cF.key+L.totalRange-1)}cE=cy.headerFormat.replace("{point.key}",cB)}else{cE=aW.call(cH,cF)}return cE};cc.destroy=function(){var cw=this,M=cw.groupedData||[],L=M.length;while(L--){if(M[L]){M[L].destroy()}}ci.apply(cw)};bc(cc,"setOptions",function(cz,cy){var cw=cz.call(this,cy),cx=this.type,M=this.chart.options.plotOptions,L=at[cx].dataGrouping;if(a1[cx]){if(!L){L=aY(h,a1[cx])}cw.dataGrouping=aY(L,M.series&&M.series.dataGrouping,M[cx].dataGrouping,cy.dataGrouping)}if(this.chart.options._stock){this.requireSorting=true}return cw});bc(C.prototype,"setScale",function(L){L.call(this);I(this.series,function(M){M.hasProcessed=false})});C.prototype.getGroupPixelWidth=function(){var cy=this.series,L=cy.length,cx,cz=0,M=false,cA,cw;cx=L;while(cx--){cw=cy[cx].options.dataGrouping;if(cw){cz=cu(cz,cw.groupPixelWidth)}}cx=L;while(cx--){cw=cy[cx].options.dataGrouping;if(cw&&cy[cx].hasProcessed){cA=(cy[cx].processedXData||cy[cx].data).length;if(cy[cx].groupPixelWidth||cA>(this.chart.plotSizeX/cz)||(cA&&cw.forced)){M=true}}}return M?cz:0};at.ohlc=aY(at.column,{lineWidth:1,tooltip:{pointFormat:'<span style="color:{series.color};font-weight:bold">{series.name}</span><br/>Open: {point.open}<br/>High: {point.high}<br/>Low: {point.low}<br/>Close: {point.close}<br/>'},states:{hover:{lineWidth:3}},threshold:null});var aq=bA(a.column,{type:"ohlc",pointArrayMap:["open","high","low","close"],toYData:function(L){return[L.open,L.high,L.low,L.close]},pointValKey:"high",pointAttrToOptions:{stroke:"color","stroke-width":"lineWidth"},upColorProp:"stroke",getAttribs:function(){a.column.prototype.getAttribs.apply(this,arguments);var cw=this,L=cw.options,cz=L.states,cy=L.upColor||cw.color,cx=aY(cw.pointAttr),M=cw.upColorProp;cx[""][M]=cy;cx.hover[M]=cz.hover.upColor||cy;cx.select[M]=cz.select.upColor||cy;I(cw.points,function(cA){if(cA.open<cA.close){cA.pointAttr=cx}})},translate:function(){var M=this,L=M.yAxis;a.column.prototype.translate.apply(M);I(M.points,function(cw){if(cw.open!==null){cw.plotOpen=L.translate(cw.open,0,1,0,1)}if(cw.close!==null){cw.plotClose=L.translate(cw.close,0,1,0,1)}})},drawPoints:function(){var cz=this,cC=cz.points,cB=cz.chart,L,cx,cA,cE,cy,cD,M,cw;I(cC,function(cF){if(cF.plotY!==k){M=cF.graphic;L=cF.pointAttr[cF.selected?"selected":""];cE=(L["stroke-width"]%2)/2;cw=o(cF.plotX)-cE;cy=o(cF.shapeArgs.width/2);cD=["M",cw,o(cF.yBottom),"L",cw,o(cF.plotY)];if(cF.open!==null){cx=o(cF.plotOpen)+cE;cD.push("M",cw,cx,"L",cw-cy,cx)}if(cF.close!==null){cA=o(cF.plotClose)+cE;cD.push("M",cw,cA,"L",cw+cy,cA)}if(M){M.animate({d:cD})}else{cF.graphic=cB.renderer.path(cD).attr(L).add(cz.group)}}})},animate:null});a.ohlc=aq;at.candlestick=aY(at.column,{lineColor:"black",lineWidth:1,states:{hover:{lineWidth:2}},tooltip:at.ohlc.tooltip,threshold:null,upColor:"white"});var bs=bA(aq,{type:"candlestick",pointAttrToOptions:{fill:"color",stroke:"lineColor","stroke-width":"lineWidth"},upColorProp:"fill",getAttribs:function(){a.ohlc.prototype.getAttribs.apply(this,arguments);var cx=this,cw=cx.options,cz=cw.states,M=cw.upLineColor||cw.lineColor,cy=cz.hover.upLineColor||M,L=cz.select.upLineColor||M;I(cx.points,function(cA){if(cA.open<cA.close){cA.pointAttr[""].stroke=M;cA.pointAttr.hover.stroke=cy;cA.pointAttr.select.stroke=L}})},drawPoints:function(){var cC=this,cG=cC.points,cF=cC.chart,L,cB=cC.pointAttr[""],cz,cE,cw,cD,cy,cJ,cI,cx,M,cH,cA;I(cG,function(cK){M=cK.graphic;if(cK.plotY!==k){L=cK.pointAttr[cK.selected?"selected":""]||cB;cI=(L["stroke-width"]%2)/2;cx=o(cK.plotX)-cI;cz=cK.plotOpen;cE=cK.plotClose;cw=a8.min(cz,cE);cD=a8.max(cz,cE);cA=o(cK.shapeArgs.width/2);cy=o(cw)!==o(cK.plotY);cJ=cD!==cK.yBottom;cw=o(cw)+cI;cD=o(cD)+cI;cH=["M",cx-cA,cD,"L",cx-cA,cw,"L",cx+cA,cw,"L",cx+cA,cD,"Z","M",cx,cw,"L",cx,cy?o(cK.plotY):cw,"M",cx,cD,"L",cx,cJ?o(cK.yBottom):cD,"Z"];if(M){M.animate({d:cH})}else{cK.graphic=cF.renderer.path(cH).attr(L).add(cC.group).shadow(cC.options.shadow)}}})}});a.candlestick=bs;var aV=d.prototype.symbols;at.flags=aY(at.column,{dataGrouping:null,fillColor:"white",lineWidth:1,pointRange:0,shape:"flag",stackDistance:12,states:{hover:{lineColor:"black",fillColor:"#FCFFC5"}},style:{fontSize:"11px",fontWeight:"bold",textAlign:"center"},tooltip:{pointFormat:"{point.text}<br/>"},threshold:null,y:-30});a.flags=bA(a.column,{type:"flags",sorted:false,noSharedTooltip:true,takeOrdinalPosition:false,trackerGroups:["markerGroup"],forceCrop:true,init:bq.prototype.init,pointAttrToOptions:{fill:"fillColor",stroke:"color","stroke-width":"lineWidth",r:"radius"},translate:function(){a.column.prototype.translate.apply(this);var cE=this,cx=cE.options,cF=cE.chart,cJ=cE.points,cz=cJ.length-1,cG,cy,cw=cx.onSeries,cI=cw&&cF.get(cw),cA=cI&&cI.options.step,cH=cI&&cI.points,cK=cH&&cH.length,cC=cE.xAxis,cL=cC.getExtremes(),L,cB,M,cD;if(cI&&cI.visible&&cK){cD=cI.currentDataGrouping;cB=cH[cK-1].x+(cD?cD.totalRange:0);cJ.sort(function(cN,cM){return(cN.x-cM.x)});while(cK--&&cJ[cz]){cG=cJ[cz];L=cH[cK];if(L.x<=cG.x&&L.plotY!==k){if(cG.x<=cB){cG.plotY=L.plotY;if(L.x<cG.x&&!cA){M=cH[cK+1];if(M&&M.plotY!==k){cG.plotY+=((cG.x-L.x)/(M.x-L.x))*(M.plotY-L.plotY)}}}cz--;cK++;if(cz<0){break}}}}I(cJ,function(cM,cN){if(cM.plotY===k){if(cM.x>=cL.min&&cM.x<=cL.max){cM.plotY=cF.chartHeight-cC.bottom-(cC.opposite?cC.height:0)+cC.offset-cF.plotTop}else{cM.shapeArgs={}}}cy=cJ[cN-1];if(cy&&cy.plotX===cM.plotX){if(cy.stackIndex===k){cy.stackIndex=0}cM.stackIndex=cy.stackIndex+1}})},drawPoints:function(){var cB=this,cC,cL=cB.pointAttr[""],cJ=cB.points,cE=cB.chart,cH=cE.renderer,cz,cx,cy=cB.options,cA=cy.y,L,cK,cI,cD,cF,cM=(cy.lineWidth%2/2),cw,M,cG;cK=cJ.length;while(cK--){cI=cJ[cK];cG=cI.plotX>cB.xAxis.len;cz=cI.plotX+(cG?cM:-cM);cF=cI.stackIndex;L=cI.options.shape||cy.shape;cx=cI.plotY;if(cx!==k){cx=cI.plotY+cA+cM-(cF!==k&&cF*cy.stackDistance)}cw=cF?k:cI.plotX+cM;M=cF?k:cI.plotY;cD=cI.graphic;if(cx!==k&&cz>=0&&!cG){cC=cI.pointAttr[cI.selected?"select":""]||cL;if(cD){cD.attr({x:cz,y:cx,r:cC.r,anchorX:cw,anchorY:M})}else{cD=cI.graphic=cH.label(cI.options.title||cy.title||"A",cz,cx,L,cw,M,cy.useHTML).css(aY(cy.style,cI.style)).attr(cC).attr({align:L==="flag"?"left":"center",width:cy.width,height:cy.height}).add(cB.markerGroup).shadow(cy.shadow)}cI.tooltipPos=[cz,cx]}else{if(cD){cI.graphic=cD.destroy()}}}},drawTracker:function(){var L=this,M=L.points;aU.drawTrackerPoint.apply(this);I(M,function(cw){var cx=cw.graphic;if(cx){z(cx.element,"mouseover",function(){if(cw.stackIndex>0&&!cw.raised){cw._y=cx.y;cx.attr({y:cw._y-8});cw.raised=true}I(M,function(cy){if(cy!==cw&&cy.raised&&cy.graphic){cy.graphic.attr({y:cy._y});cy.raised=false}})})}})},animate:j});aV.flag=function(M,cA,cw,cy,cx){var L=(cx&&cx.anchorX)||M,cz=(cx&&cx.anchorY)||cA;return["M",L,cz,"L",M,cA+cy,M,cA,M+cw,cA,M+cw,cA+cy,M,cA+cy,"M",L,cz,"Z"]};I(["circle","square"],function(L){aV[L+"pin"]=function(cA,cz,cB,cy,cD){var cw=cD&&cD.anchorX,M=cD&&cD.anchorY,cC=aV[L](cA,cz,cB,cy),cx;if(cw&&M){cx=(cz>M)?cz:cz+cy;cC.push("M",cw,cx,"L",cw,M)}return cC}});if(cf===aZ.VMLRenderer){I(["flag","circlepin","squarepin"],function(L){ct.prototype.symbols[L]=aV[L]})}var ad={linearGradient:{x1:0,y1:0,x2:0,y2:1},stops:[[0,"#FFF"],[1,"#CCC"]]},bv=[].concat(co),bR;bv[4]=[b5,[1,2,3,4]];bv[5]=[ch,[1,2,3]];bR=a.areaspline===k?"line":"areaspline";bD(bS,{navigator:{handles:{backgroundColor:"#FFF",borderColor:"#666"},height:40,margin:10,maskFill:"rgba(255, 255, 255, 0.75)",outlineColor:"#444",outlineWidth:1,series:{type:bR,color:"#4572A7",compare:null,fillOpacity:0.4,dataGrouping:{approximation:"average",enabled:true,groupPixelWidth:2,smoothed:true,units:bv},dataLabels:{enabled:false,zIndex:2},id:bk+"navigator-series",lineColor:"#4572A7",lineWidth:1,marker:{enabled:false},pointRange:0,shadow:false,threshold:null},xAxis:{tickWidth:0,lineWidth:0,gridLineWidth:1,tickPixelInterval:200,labels:{align:"left",x:3,y:-4},crosshair:false},yAxis:{gridLineWidth:0,startOnTick:false,endOnTick:false,minPadding:0.1,maxPadding:0.1,labels:{enabled:false},crosshair:false,title:{text:null},tickWidth:0}},scrollbar:{height:ba?20:14,barBackgroundColor:ad,barBorderRadius:2,barBorderWidth:1,barBorderColor:"#666",buttonArrowColor:"#666",buttonBackgroundColor:ad,buttonBorderColor:"#666",buttonBorderRadius:2,buttonBorderWidth:1,minWidth:6,rifleColor:"#666",trackBackgroundColor:{linearGradient:{x1:0,y1:0,x2:0,y2:1},stops:[[0,"#EEE"],[1,"#FFF"]]},trackBorderColor:"#CCC",trackBorderWidth:1,liveRedraw:cl&&!ba}});function bI(cx){var cA=cx.options,cw=cA.navigator,M=cw.enabled,cz=cA.scrollbar,cy=cz.enabled,L=M?cw.height:0,cB=cy?cz.height:0;this.handles=[];this.scrollbarButtons=[];this.elementsToDestroy=[];this.chart=cx;this.setBaseSeries();this.height=L;this.scrollbarHeight=cB;this.scrollbarEnabled=cy;this.navigatorEnabled=M;this.navigatorOptions=cw;this.scrollbarOptions=cz;this.outlineHeight=L+cB;this.init()}bI.prototype={drawHandle:function(cC,cy){var cx=this,cB=cx.chart,cA=cB.renderer,M=cx.elementsToDestroy,cD=cx.handles,L=cx.navigatorOptions.handles,cz={fill:L.backgroundColor,stroke:L.borderColor,"stroke-width":1},cw;if(!cx.rendered){cD[cy]=cA.g("navigator-handle-"+["left","right"][cy]).css({cursor:"e-resize"}).attr({zIndex:4-cy}).add();cw=cA.rect(-4.5,0,9,16,3,1).attr(cz).add(cD[cy]);M.push(cw);cw=cA.path(["M",-1.5,4,"L",-1.5,12,"M",0.5,4,"L",0.5,12]).attr(cz).add(cD[cy]);M.push(cw)}cD[cy][cB.isResizing?"animate":"attr"]({translateX:cx.scrollerLeft+cx.scrollbarHeight+parseInt(cC,10),translateY:cx.top+cx.height/2-8})},drawScrollbarButton:function(cz){var cy=this,cB=cy.chart,cA=cB.renderer,M=cy.elementsToDestroy,cC=cy.scrollbarButtons,L=cy.scrollbarHeight,cx=cy.scrollbarOptions,cw;if(!cy.rendered){cC[cz]=cA.g().add(cy.scrollbarGroup);cw=cA.rect(-0.5,-0.5,L+1,L+1,cx.buttonBorderRadius,cx.buttonBorderWidth).attr({stroke:cx.buttonBorderColor,"stroke-width":cx.buttonBorderWidth,fill:cx.buttonBackgroundColor}).add(cC[cz]);M.push(cw);cw=cA.path(["M",L/2+(cz?-1:1),L/2-3,"L",L/2+(cz?-1:1),L/2+3,L/2+(cz?2:-2),L/2]).attr({fill:cx.buttonArrowColor}).add(cC[cz]);M.push(cw)}if(cz){cC[cz].attr({translateX:cy.scrollerWidth-L})}},render:function(c6,cM,cG,c1){var cI=this,c5=cI.chart,cV=c5.renderer,cR,cH,c2,cz,cP=cI.scrollbarGroup,cY=cI.navigatorGroup,c4=cI.scrollbar,cN=cI.xAxis,cO=cI.scrollbarTrack,L=cI.scrollbarHeight,cx=cI.scrollbarEnabled,cE=cI.navigatorOptions,cJ=cI.scrollbarOptions,cX=cJ.minWidth,M=cI.height,cB=cI.top,c7=cI.navigatorEnabled,cK=cE.outlineWidth,cT=cK/2,cF,c0,cC,cS,c3,cZ=0,cw=cI.outlineHeight,cL=cJ.barBorderRadius,cW,cD=cJ.barBorderWidth,cA,cU=cB+cT,cQ,cy;if(isNaN(c6)){return}cI.navigatorLeft=cR=a0(cN.left,c5.plotLeft+L);cI.navigatorWidth=cH=a0(cN.len,c5.plotWidth-2*L);cI.scrollerLeft=c2=cR-L;cI.scrollerWidth=cz=cz=cH+2*L;if(cN.getExtremes){cy=cI.getUnionExtremes(true);if(cy&&(cy.dataMin!==cN.min||cy.dataMax!==cN.max)){cN.setExtremes(cy.dataMin,cy.dataMax,true,false)}}cG=a0(cG,cN.translate(c6));c1=a0(c1,cN.translate(cM));if(isNaN(cG)||f(cG)===Infinity){cG=0;c1=cz}if(cN.translate(c1,true)-cN.translate(cG,true)<c5.xAxis[0].minRange){return}cI.zoomedMax=aw(cu(cG,c1),cH);cI.zoomedMin=cu(cI.fixedWidth?cI.zoomedMax-cI.fixedWidth:aw(cG,c1),0);cI.range=cI.zoomedMax-cI.zoomedMin;c0=o(cI.zoomedMax);cF=o(cI.zoomedMin);cC=c0-cF;if(!cI.rendered){if(c7){cI.navigatorGroup=cY=cV.g("navigator").attr({zIndex:3}).add();cI.leftShade=cV.rect().attr({fill:cE.maskFill}).add(cY);cI.rightShade=cV.rect().attr({fill:cE.maskFill}).add(cY);cI.outline=cV.path().attr({"stroke-width":cK,stroke:cE.outlineColor}).add(cY)}if(cx){cI.scrollbarGroup=cP=cV.g("scrollbar").add();cW=cJ.trackBorderWidth;cI.scrollbarTrack=cO=cV.rect().attr({x:0,y:-cW%2/2,fill:cJ.trackBackgroundColor,stroke:cJ.trackBorderColor,"stroke-width":cW,r:cJ.trackBorderRadius||0,height:L}).add(cP);cI.scrollbar=c4=cV.rect().attr({y:-cD%2/2,height:L,fill:cJ.barBackgroundColor,stroke:cJ.barBorderColor,"stroke-width":cD,r:cL}).add(cP);cI.scrollbarRifles=cV.path().attr({stroke:cJ.rifleColor,"stroke-width":1}).add(cP)}}cQ=c5.isResizing?"animate":"attr";if(c7){cI.leftShade[cQ]({x:cR,y:cB,width:cF,height:M});cI.rightShade[cQ]({x:cR+c0,y:cB,width:cH-c0,height:M});cI.outline[cQ]({d:[bN,c2,cU,bO,cR+cF+cT,cU,cR+cF+cT,cU+cw-L,bN,cR+c0-cT,cU+cw-L,bO,cR+c0-cT,cU,c2+cz,cU]});cI.drawHandle(cF+cT,0);cI.drawHandle(c0+cT,1)}if(cx&&cP){cI.drawScrollbarButton(0);cI.drawScrollbarButton(1);cP[cQ]({translateX:c2,translateY:o(cU+M)});cO[cQ]({width:cz});cS=L+cF;c3=cC-cD;if(c3<cX){cZ=(cX-c3)/2;c3=cX;cS-=cZ}cI.scrollbarPad=cZ;c4[cQ]({x:bE(cS)+(cD%2/2),width:c3});cA=L+cF+cC/2-0.5;cI.scrollbarRifles.attr({visibility:cC>12?av:ap})[cQ]({d:[bN,cA-3,L/4,bO,cA-3,2*L/3,bN,cA,L/4,bO,cA,2*L/3,bN,cA+3,L/4,bO,cA+3,2*L/3]})}cI.scrollbarPad=cZ;cI.rendered=true},addEvents:function(){var cw=this.chart.container,L=this.mouseDownHandler,M=this.mouseMoveHandler,cx=this.mouseUpHandler,cy;cy=[[cw,"mousedown",L],[cw,"mousemove",M],[document,"mouseup",cx]];if(H){cy.push([cw,"touchstart",L],[cw,"touchmove",M],[document,"touchend",cx])}I(cy,function(cz){z.apply(null,cz)});this._events=cy},removeEvents:function(){I(this._events,function(L){bh.apply(null,L)});this._events=k;if(this.navigatorEnabled&&this.baseSeries){bh(this.baseSeries,"updatedData",this.updatedDataHandler)}},init:function(){var cC=this,cD=cC.chart,cx,L,M=cC.scrollbarHeight,cy=cC.navigatorOptions,cH=cC.height,cF=cC.top,cB,cA,cE=document.body.style,cw,cI=cC.baseSeries;cC.mouseDownHandler=function(c0){c0=cD.pointer.normalize(c0);var cV=cC.zoomedMin,cY=cC.zoomedMax,cX=cC.top,cS=cC.scrollbarHeight,cU=cC.scrollerLeft,c1=cC.scrollerWidth,cL=cC.navigatorLeft,cQ=cC.navigatorWidth,cP=cC.scrollbarPad,cW=cC.range,cT=c0.chartX,cR=c0.chartY,cZ=cD.xAxis[0],cN,cO,cK=ba?10:7,cM,cJ;if(cR>cX&&cR<cX+cH+cS){cJ=!cC.scrollbarEnabled||cR<cX+cH;if(cJ&&a8.abs(cT-cV-cL)<cK){cC.grabbedLeft=true;cC.otherHandlePos=cY;cC.fixedExtreme=cZ.max;cD.fixedRange=null}else{if(cJ&&a8.abs(cT-cY-cL)<cK){cC.grabbedRight=true;cC.otherHandlePos=cV;cC.fixedExtreme=cZ.min;cD.fixedRange=null}else{if(cT>cL+cV-cP&&cT<cL+cY+cP){cC.grabbedCenter=cT;cC.fixedWidth=cW;if(cD.renderer.isSVG){cw=cE.cursor;cE.cursor="ew-resize"}cB=cT-cV}else{if(cT>cU&&cT<cU+c1){if(cJ){cM=cT-cL-cW/2}else{if(cT<cL){cM=cV-cW*0.2}else{if(cT>cU+c1-cS){cM=cV+cW*0.2}else{cM=cT<cL+cV?cV-cW:cY}}}if(cM<0){cM=0}else{if(cM+cW>=cQ){cM=cQ-cW;cN=cx.dataMax}}if(cM!==cV){cC.fixedWidth=cW;cO=cx.toFixedRange(cM,cM+cW,null,cN);cZ.setExtremes(cO.min,cO.max,true,false,{trigger:"navigator"})}}}}}}};cC.mouseMoveHandler=function(cO){var cQ=cC.scrollbarHeight,cP=cC.navigatorLeft,cN=cC.navigatorWidth,cL=cC.scrollerLeft,cM=cC.scrollerWidth,cK=cC.range,cJ;if(cO.pageX!==0){cO=cD.pointer.normalize(cO);cJ=cO.chartX;if(cJ<cP){cJ=cP}else{if(cJ>cL+cM-cQ){cJ=cL+cM-cQ}}if(cC.grabbedLeft){cA=true;cC.render(0,0,cJ-cP,cC.otherHandlePos)}else{if(cC.grabbedRight){cA=true;cC.render(0,0,cC.otherHandlePos,cJ-cP)}else{if(cC.grabbedCenter){cA=true;if(cJ<cB){cJ=cB}else{if(cJ>cN+cB-cK){cJ=cN+cB-cK}}cC.render(0,0,cJ-cB,cJ-cB+cK)}}}if(cA&&cC.scrollbarOptions.liveRedraw){setTimeout(function(){cC.mouseUpHandler(cO)},0)}}};cC.mouseUpHandler=function(cM){var cK,cL,cJ;if(cA){if(cC.zoomedMin===cC.otherHandlePos){cL=cC.fixedExtreme}else{if(cC.zoomedMax===cC.otherHandlePos){cJ=cC.fixedExtreme}}cK=cx.toFixedRange(cC.zoomedMin,cC.zoomedMax,cL,cJ);cD.xAxis[0].setExtremes(cK.min,cK.max,true,false,{trigger:"navigator",triggerOp:"navigator-drag",DOMEvent:cM})}if(cM.type!=="mousemove"){cC.grabbedLeft=cC.grabbedRight=cC.grabbedCenter=cC.fixedWidth=cC.fixedExtreme=cC.otherHandlePos=cA=cB=null;cE.cursor=cw||""}};var cz=cD.xAxis.length,cG=cD.yAxis.length;cD.extraBottomMargin=cC.outlineHeight+cy.margin;if(cC.navigatorEnabled){cC.xAxis=cx=new C(cD,aY({ordinal:cI&&cI.xAxis.options.ordinal},cy.xAxis,{id:"navigator-x-axis",isX:true,type:"datetime",index:cz,height:cH,offset:0,offsetLeft:M,offsetRight:-M,keepOrdinalPadding:true,startOnTick:false,endOnTick:false,minPadding:0,maxPadding:0,zoomEnabled:false}));cC.yAxis=L=new C(cD,aY(cy.yAxis,{id:"navigator-y-axis",alignTicks:false,height:cH,offset:0,index:cG,zoomEnabled:false}));if(cI||cy.series.data){cC.addBaseSeries()}else{if(cD.series.length===0){bc(cD,"redraw",function(cJ,cK){if(cD.series.length>0&&!cC.series){cC.setBaseSeries();cD.redraw=cJ}cJ.call(cD,cK)})}}}else{cC.xAxis=cx={translate:function(cM,cK){var cL=cD.xAxis[0].getExtremes(),cJ=cD.plotWidth-2*M,cO=cL.dataMin,cN=cL.dataMax-cO;return cK?(cM*cN/cJ)+cO:cJ*(cM-cO)/cN},toFixedRange:C.prototype.toFixedRange}}bc(cD,"getMargins",function(cL){var cK=this.legend,cJ=cK.options;cL.call(this);cC.top=cF=cC.navigatorOptions.top||this.chartHeight-cC.height-cC.scrollbarHeight-this.spacing[2]-(cJ.verticalAlign==="bottom"&&cJ.enabled&&!cJ.floating?cK.legendHeight+a0(cJ.margin,10):0);if(cx&&L){cx.options.top=L.options.top=cF;cx.setAxisSize();L.setAxisSize()}});cC.addEvents()},getUnionExtremes:function(M){var cw=this.chart.xAxis[0],L=this.xAxis,cx=L.options;if(!M||cw.dataMin!==null){return{dataMin:a0(cx&&cx.min,((an(cw.dataMin)&&an(L.dataMin))?aw:a0)(cw.dataMin,L.dataMin)),dataMax:a0(cx&&cx.max,((an(cw.dataMax)&&an(L.dataMax))?cu:a0)(cw.dataMax,L.dataMax))}}},setBaseSeries:function(L){var M=this.chart;L=L||M.options.navigator.baseSeries;if(this.series){this.series.remove()}this.baseSeries=M.series[L]||(typeof L==="string"&&M.get(L))||M.series[0];if(this.xAxis){this.addBaseSeries()}},addBaseSeries:function(){var cw=this.baseSeries,M=cw?cw.options:{},cy=M.data,cz,L=this.navigatorOptions.series,cx;cx=L.data;this.hasNavigatorData=!!cx;cz=aY(M,L,{clip:false,enableMouseTracking:false,group:"nav",padXAxis:false,xAxis:"navigator-x-axis",yAxis:"navigator-y-axis",name:"Navigator",showInLegend:false,isInternal:true,visible:true});cz.data=cx||cy;this.series=this.chart.initSeries(cz);if(cw&&this.navigatorOptions.adaptToUpdatedData!==false){z(cw,"updatedData",this.updatedDataHandler);cw.userOptions.events=bD(cw.userOptions.event,{updatedData:this.updatedDataHandler})}},updatedDataHandler:function(cH,M,cK){if(typeof(M)==="undefined"){M=false}var cF=this.chart.scroller,L=cF.baseSeries,cD=L.xAxis,cx=cD.getExtremes(),cy=cx.min,cC=cx.max,cG=cx.dataMin,cJ=cx.dataMax,cA=cC-cy,cI,cL,cB,cz,cN,cE=cF.series,cw=cE.xData,cM=!!cD.setExtremes;cL=cC>=cw[cw.length-1]-(this.closestPointRange||0);cI=cy<=cG;if(M){cE.options.pointStart=cE.xData[0];cE.addPoint({x:cK,y:0},false);cN=true}else{if(!cF.hasNavigatorData){cE.options.pointStart=L.xData[0];cE.setData(L.options.data,false);cN=true}}if(cI){cz=cG;cB=cz+cA}if(cL){cB=cJ;if(!cI){cz=cu(cB-cA,cE.xData[0])}}if(cM&&(cI||cL)){if(!isNaN(cz)){cD.setExtremes(cz,cB,true,false,{trigger:"updatedData"})}}else{if(cN){this.chart.redraw(false)}cF.render(cu(cy,cG),aw(cC,cJ))}},destroy:function(){var L=this;L.removeEvents();I([L.xAxis,L.yAxis,L.leftShade,L.rightShade,L.outline,L.scrollbarTrack,L.scrollbarRifles,L.scrollbarGroup,L.scrollbar],function(M){if(M&&M.destroy){M.destroy()}});L.xAxis=L.yAxis=L.leftShade=L.rightShade=L.outline=L.scrollbarTrack=L.scrollbarRifles=L.scrollbarGroup=L.scrollbar=null;I([L.scrollbarButtons,L.handles,L.elementsToDestroy],function(M){bp(M)})}};aZ.Scroller=bI;bc(C.prototype,"zoom",function(cz,L,cB){var cA=this.chart,M=cA.options,cD=M.chart.zoomType,cw,cC=M.navigator,cy=M.rangeSelector,cx;if(this.isXAxis&&((cC&&cC.enabled)||(cy&&cy.enabled))){if(cD==="x"){cA.resetZoomButton="blocked"}else{if(cD==="y"){cx=false}else{if(cD==="xy"){cw=this.previousZoom;if(an(L)){this.previousZoom=[this.min,this.max]}else{if(cw){L=cw[0];cB=cw[1];delete this.previousZoom}}}}}}return cx!==k?cx:cz.call(this,L,cB)});bc(bB.prototype,"init",function(M,L,cw){z(this,"beforeRender",function(){var cx=this.options;if(cx.navigator.enabled||cx.scrollbar.enabled){this.scroller=new bI(this)}});M.call(this,L,cw)});bc(bq.prototype,"addPoint",function(cx,cw,cz,M,cy){var L=this.options.turboThreshold;if(L&&this.xData.length>L&&cr(cw)&&!aP(cw)&&this.chart.scroller){b9(20,true)}cx.call(this,cw,cz,M,cy)});bD(bS,{rangeSelector:{buttonTheme:{width:28,height:16,padding:1,r:0,stroke:"#68A",zIndex:7},inputPosition:{align:"right"},labelStyle:{color:"#666"}}});bS.lang=aY(bS.lang,{rangeSelectorZoom:"Zoom",rangeSelectorFrom:"From",rangeSelectorTo:"To"});function Q(L){this.init(L)}Q.prototype={clickButton:function(cL,cK){var cE=this,cJ=cE.selected,cH=cE.chart,cM=cE.buttons,cD=cE.buttonOptions[cL],cB=cH.xAxis[0],cy=(cH.scroller&&cH.scroller.getUnionExtremes())||cB||{},cO=cy.dataMin,cP=cy.dataMax,cF,cI=cB&&o(aw(cB.max,a0(cP,cB.max))),M,cN=new Date(cI),cx=cD.type,cA=cD.count,cw,cG=cD._range,cz,cC,L;if(cO===null||cP===null||cL===cE.selected){return}if(cx==="month"||cx==="year"){L={month:"Month",year:"FullYear"}[cx];cN["set"+L](cN["get"+L]()-cA);cF=cN.getTime();cO=a0(cO,Number.MIN_VALUE);if(isNaN(cF)||cF<cO){cF=cO;cI=aw(cF+cG,cP)}else{cG=cI-cF}}else{if(cG){cF=cu(cI-cG,cO);cI=aw(cF+cG,cP)}else{if(cx==="ytd"){if(cB){if(cP===k){cO=Number.MAX_VALUE;cP=Number.MIN_VALUE;I(cH.series,function(cQ){var cR=cQ.xData;cO=aw(cR[0],cO);cP=cu(cR[cR.length-1],cP)});cK=false}M=new Date(cP);cC=M.getFullYear();cF=cz=cu(cO||0,Date.UTC(cC,0,1));M=M.getTime();cI=aw(cP||M,M)}else{z(cH,"beforeRender",function(){cE.clickButton(cL)});return}}else{if(cx==="all"&&cB){cF=cO;cI=cP}}}}if(cM[cJ]){cM[cJ].setState(0)}if(cM[cL]){cM[cL].setState(2)}cH.fixedRange=cG;if(!cB){cw=cH.options.xAxis;cw[0]=aY(cw[0],{range:cG,min:cz});cE.setSelected(cL)}else{cB.setExtremes(cF,cI,a0(cK,1),0,{trigger:"rangeSelectorButton",rangeSelectorButton:cD});cE.setSelected(cL)}},setSelected:function(L){this.selected=this.options.selected=L},defaultButtons:[{type:"month",count:1,text:"1m"},{type:"month",count:3,text:"3m"},{type:"month",count:6,text:"6m"},{type:"ytd",text:"YTD"},{type:"year",count:1,text:"1y"},{type:"all",text:"All"}],init:function(cw){var cy=this,L=cw.options.rangeSelector,cz=L.buttons||[].concat(cy.defaultButtons),M=L.selected,cx=cy.blurInputs=function(){var cA=cy.minInput,cB=cy.maxInput;if(cA){cA.blur()}if(cB){cB.blur()}};cy.chart=cw;cy.options=L;cy.buttons=[];cw.extraTopMargin=25;cy.buttonOptions=cz;z(cw.container,"mousedown",cx);z(cw,"resize",cx);I(cz,cy.computeButtonRange);if(M!==k&&cz[M]){this.clickButton(M,false)}z(cw,"load",function(){z(cw.xAxis[0],"afterSetExtremes",function(){cy.updateButtonStates(true)})})},updateButtonStates:function(cB){var cy=this,cz=this.chart,L=cz.xAxis[0],cx=(cz.scroller&&cz.scroller.getUnionExtremes())||L,cC=cx.dataMin,M=cx.dataMax,cw=cy.selected,cA=cy.buttons;if(cB&&cz.fixedRange!==o(L.max-L.min)){if(cA[cw]){cA[cw].setState(0)}cy.setSelected(null)}I(cy.buttonOptions,function(cI,cH){var cF=cI._range,cG=cF>M-cC,cE=cF<L.minRange,cJ=cI.type==="all"&&L.max-L.min>=M-cC&&cA[cH].state!==2,cD=cI.type==="ytd"&&cb("%Y",cC)===cb("%Y",M);if(cF===o(L.max-L.min)&&cH!==cw){cy.setSelected(cH);cA[cH].setState(2)}else{if(cG||cE||cJ||cD){cA[cH].setState(3)}else{if(cA[cH].state===3){cA[cH].setState(0)}}}})},computeButtonRange:function(cw){var M=cw.type,cx=cw.count||1,L={millisecond:1,second:1000,minute:60*1000,hour:3600*1000,day:24*3600*1000,week:7*24*3600*1000};if(L[M]){cw._range=L[M]*cx}else{if(M==="month"||M==="year"){cw._range={month:30,year:365}[M]*24*3600000*cx}}},setInputValue:function(M,cw){var L=this.chart.options.rangeSelector;if(an(cw)){this[M+"Input"].HCTime=cw}this[M+"Input"].value=cb(L.inputEditDateFormat||"%Y-%m-%d",this[M+"Input"].HCTime);this[M+"DateBox"].attr({text:cb(L.inputDateFormat||"%b %e, %Y",this[M+"Input"].HCTime)})},drawInput:function(cw){var cB=this,cD=cB.chart,cA=cD.renderer.style,cC=cD.renderer,cG=cD.options.rangeSelector,cx=bS.lang,M=cB.div,cz=cw==="min",cF,cE,L,cy=this.inputGroup;this[cw+"Label"]=cE=cC.label(cx[cz?"rangeSelectorFrom":"rangeSelectorTo"],this.inputGroup.offset).attr({padding:1}).css(aY(cA,cG.labelStyle)).add(cy);cy.offset+=cE.width+5;this[cw+"DateBox"]=L=cC.label("",cy.offset).attr({padding:1,width:cG.inputBoxWidth||90,height:cG.inputBoxHeight||16,stroke:cG.inputBoxBorderColor||"silver","stroke-width":1}).css(aY({textAlign:"center"},cA,cG.inputStyle)).on("click",function(){cB[cw+"Input"].focus()}).add(cy);cy.offset+=L.width+(cz?10:0);this[cw+"Input"]=cF=bF("input",{name:cw,className:bk+"range-selector",type:"text"},bD({position:ax,border:0,width:"1px",height:"1px",padding:0,textAlign:"center",fontSize:cA.fontSize,fontFamily:cA.fontFamily,top:cD.plotTop+ab},cG.inputStyle),M);cF.onfocus=function(){cp(this,{left:(cy.translateX+L.x)+ab,top:cy.translateY+ab,width:(L.width-2)+ab,height:(L.height-2)+ab,border:"2px solid silver"})};cF.onblur=function(){cp(this,{border:0,width:"1px",height:"1px"});cB.setInputValue(cw)};cF.onchange=function(){var cH=cF.value,cK=(cG.inputDateParser||Date.parse)(cH),cJ=cD.xAxis[0],cL=cJ.dataMin,cI=cJ.dataMax;if(isNaN(cK)){cK=cH.split("-");cK=Date.UTC(b8(cK[0]),b8(cK[1])-1,b8(cK[2]))}if(!isNaN(cK)){if(!bS.global.useUTC){cK=cK+new Date().getTimezoneOffset()*60*1000}if(cz){if(cK>cB.maxInput.HCTime){cK=k}else{if(cK<cL){cK=cL}}}else{if(cK<cB.minInput.HCTime){cK=k}else{if(cK>cI){cK=cI}}}if(cK!==k){cD.xAxis[0].setExtremes(cz?cK:cJ.min,cz?cJ.max:cK,k,k,{trigger:"rangeSelectorInput"})}}}},render:function(cF,cI){var cx=this,cA=cx.chart,cE=cA.renderer,cy=cA.container,cH=cA.options,L=cH.exporting&&cH.navigation&&cH.navigation.buttonOptions,M=cH.rangeSelector,cJ=cx.buttons,cM=bS.lang,cz=cx.div,cC=cx.inputGroup,cL=M.buttonTheme,cD=M.inputEnabled!==false,cw=cL&&cL.states,cB=cA.plotLeft,cK,cG;if(!cx.rendered){cx.zoomText=cE.text(cM.rangeSelectorZoom,cB,cA.plotTop-10).css(M.labelStyle).add();cG=cB+cx.zoomText.getBBox().width+5;I(cx.buttonOptions,function(cO,cN){cJ[cN]=cE.button(cO.text,cG,cA.plotTop-25,function(){cx.clickButton(cN);cx.isActive=true},cL,cw&&cw.hover,cw&&cw.select).css({textAlign:"center"}).add();cG+=cJ[cN].width+(M.buttonSpacing||0);if(cx.selected===cN){cJ[cN].setState(2)}});cx.updateButtonStates();if(cD){cx.div=cz=bF("div",null,{position:"relative",height:0,zIndex:1});cy.parentNode.insertBefore(cz,cy);cx.inputGroup=cC=cE.g("input-group").add();cC.offset=0;cx.drawInput("min");cx.drawInput("max")}}if(cD){cK=cA.plotTop-35;cC.align(bD({y:cK,width:cC.offset,x:L&&(cK<(L.y||0)+L.height-cA.spacing[0])?-40:0},M.inputPosition),true,cA.spacingBox);cx.setInputValue("min",cF);cx.setInputValue("max",cI)}cx.rendered=true},destroy:function(){var L=this.minInput,M=this.maxInput,cx=this.chart,cy=this.blurInputs,cw;bh(cx.container,"mousedown",cy);bh(cx,"resize",cy);bp(this.buttons);if(L){L.onfocus=L.onblur=L.onchange=null}if(M){M.onfocus=M.onblur=M.onchange=null}for(cw in this){if(this[cw]&&cw!=="chart"){if(this[cw].destroy){this[cw].destroy()}else{if(this[cw].nodeType){ca(this[cw])}}}this[cw]=null}}};C.prototype.toFixedRange=function(cx,L,cz,M){var cA=this.chart&&this.chart.fixedRange,cB=a0(cz,this.translate(cx,true)),cy=a0(M,this.translate(L,true)),cw=cA&&(cy-cB)/cA;if(cw>0.7&&cw<1.3){if(M){cB=cy-cA}else{cy=cB+cA}}return{min:cB,max:cy}};bc(bB.prototype,"init",function(M,L,cw){z(this,"init",function(){if(this.options.rangeSelector.enabled){this.rangeSelector=new Q(this)}});M.call(this,L,cw)});aZ.RangeSelector=Q;bB.prototype.callbacks.push(function(cB){var cC,cz=cB.scroller,cA=cB.rangeSelector;function M(){cC=cB.xAxis[0].getExtremes();cz.render(cC.min,cC.max)}function cx(){cC=cB.xAxis[0].getExtremes();if(!isNaN(cC.min)){cA.render(cC.min,cC.max)}}function cy(cD){if(cD.triggerOp!=="navigator-drag"){cz.render(cD.min,cD.max)}}function L(cD){cA.render(cD.min,cD.max)}function cw(){if(cz){bh(cB.xAxis[0],"afterSetExtremes",cy)}if(cA){bh(cB,"resize",cx);bh(cB.xAxis[0],"afterSetExtremes",L)}}if(cz){z(cB.xAxis[0],"afterSetExtremes",cy);bc(cB,"drawChartBox",function(cE){var cD=this.isDirtyBox;cE.call(this);if(cD){M()}});M()}if(cA){z(cB.xAxis[0],"afterSetExtremes",L);z(cB,"resize",cx);cx()}z(cB,"destroy",cw)});aZ.StockChart=function(cx,cB){var M=cx.series,cz,cy=a0(cx.navigator&&cx.navigator.enabled,true),cw=cy?{startOnTick:false,endOnTick:false}:null,L={marker:{enabled:false,states:{hover:{radius:5}}},states:{hover:{lineWidth:2}}},cA={shadow:false,borderWidth:0};cx.xAxis=ar(bw(cx.xAxis||{}),function(cC){return aY({minPadding:0,maxPadding:0,ordinal:true,title:{text:null},labels:{overflow:"justify"},showLastLabel:true},cC,{type:"datetime",categories:null},cw)});cx.yAxis=ar(bw(cx.yAxis||{}),function(cC){cz=cC.opposite;return aY({labels:{align:cz?"right":"left",x:cz?-2:2,y:-2},showLastLabel:false,title:{text:null}},cC)});cx.series=null;cx=aY({chart:{panning:true,pinchType:"x"},navigator:{enabled:true},scrollbar:{enabled:true},rangeSelector:{enabled:true},title:{text:null},tooltip:{shared:true,crosshairs:true},legend:{enabled:false},plotOptions:{line:L,spline:L,area:L,areaspline:L,arearange:L,areasplinerange:L,column:cA,columnrange:cA,candlestick:cA,ohlc:cA}},cx,{_stock:true,chart:{inverted:false}});cx.series=M;return new bB(cx,cB)};bc(aX.prototype,"init",function(cw,M,L){var cx=L.chart.pinchType||"";cw.call(this,M,L);this.pinchX=this.pinchHor=cx.indexOf("x")!==-1;this.pinchY=this.pinchVert=cx.indexOf("y")!==-1});C.prototype.getPlotLinePath=function(cJ,cD,cy,cx,cB){var cz=this,cC=(this.isLinked?this.linkedParent.series:this.series),cF=cz.chart.renderer,cA=cz.left,L=cz.top,cw,cH,M,cG,cK=[];var cE=(this.isXAxis?(an(this.options.yAxis)?[this.chart.yAxis[this.options.yAxis]]:ar(cC,function(cL){return cL.yAxis})):(an(this.options.xAxis)?[this.chart.xAxis[this.options.xAxis]]:ar(cC,function(cL){return cL.xAxis})));var cI=[];I(cE,function(cL){if(A(cL,cI)===-1){cI.push(cL)}});cB=a0(cB,cz.translate(cJ,null,null,cy));if(!isNaN(cB)){if(cz.horiz){I(cI,function(cL){cH=cL.top;cG=cH+cL.len;cw=M=o(cB+cz.transB);if((cw>=cA&&cw<=cA+cz.width)||cx){cK.push("M",cw,cH,"L",M,cG)}})}else{I(cI,function(cL){cw=cL.left;M=cw+cL.width;cH=cG=o(L+cz.height-cB);if((cH>=L&&cH<=L+cz.height)||cx){cK.push("M",cw,cH,"L",M,cG)}})}}if(cK.length>0){return cF.crispPolyLine(cK,cD||1)}else{return null}};d.prototype.crispPolyLine=function(cw,M){var L;for(L=0;L<cw.length;L=L+6){if(cw[L+1]===cw[L+4]){cw[L+1]=cw[L+4]=o(cw[L+1])-(M%2/2)}if(cw[L+2]===cw[L+5]){cw[L+2]=cw[L+5]=o(cw[L+2])+(M%2/2)}}return cw};if(cf===aZ.VMLRenderer){ct.prototype.crispPolyLine=d.prototype.crispPolyLine}bc(C.prototype,"hideCrosshair",function(M,L){M.call(this,L);if(!an(this.crossLabelArray)){return}if(an(L)){if(this.crossLabelArray[L]){this.crossLabelArray[L].hide()}}else{I(this.crossLabelArray,function(cw){cw.hide()})}});bc(C.prototype,"drawCrosshair",function(cE,cB,cI){cE.call(this,cB,cI);if(!an(this.crosshair.label)||!this.crosshair.label.enabled||!an(cI)){return}var cF=this.chart,cK=this.options.crosshair.label,M=this.isXAxis?"x":"y",cJ=this.horiz,cA=this.opposite,L=this.left,cH=this.top,cy=this.crossLabel,cG,cD,cz,cw=cK.format,cC="",cx;if(!cy){cy=this.crossLabel=cF.renderer.label().attr({align:cK.align||(cJ?"center":cA?(this.labelAlign==="right"?"right":"left"):(this.labelAlign==="left"?"left":"center")),zIndex:12,height:cJ?16:k,fill:cK.backgroundColor||(this.series[0]&&this.series[0].color)||"gray",padding:a0(cK.padding,2),stroke:cK.borderColor||null,"stroke-width":cK.borderWidth||0}).css(bD({color:"white",fontWeight:"normal",fontSize:"11px",textAlign:"center"},cK.style)).add()}if(cJ){cG=cI.plotX+L;cD=cH+(cA?0:this.height)}else{cG=cA?this.width+L:0;cD=cI.plotY+cH}if(cD<cH||cD>cH+this.height){this.hideCrosshair();return}if(!cw&&!cK.formatter){if(this.isDatetimeAxis){cC="%b %d, %Y"}cw="{value"+(cC?":"+cC:"")+"}"}cy.attr({x:cG,y:cD,text:cw?g(cw,{value:cI[M]}):cK.formatter.call(this,cI[M]),visibility:av});cz=cy.box;if(cJ){if(((this.options.tickPosition==="inside")&&!cA)||((this.options.tickPosition!=="inside")&&cA)){cD=cy.y-cz.height}}else{cD=cy.y-(cz.height/2)}if(cJ){cx={left:L-cz.x,right:L+this.width-cz.x}}else{cx={left:this.labelAlign==="left"?L:0,right:this.labelAlign==="right"?L+this.width:cF.chartWidth}}if(cy.translateX<cx.left){cG+=cx.left-cy.translateX}if(cy.translateX+cz.width>=cx.right){cG-=cy.translateX+cz.width-cx.right}cy.attr({x:cG,y:cD,visibility:av})});var b4=cc.init,Y=cc.processData,bZ=bU.prototype.tooltipFormatter;cc.init=function(){b4.apply(this,arguments);this.setCompare(this.options.compare)};cc.setCompare=function(L){this.modifyValue=(L==="value"||L==="percent")?function(cx,cw){var M=this.compareValue;if(cx!==k){cx=L==="value"?cx-M:cx=100*(cx/M)-100;if(cw){cw.change=cx}}return cx}:null;if(this.chart.hasRendered){this.isDirty=true}};cc.processData=function(){var cw=this,M=0,L,cy,cx;Y.apply(this,arguments);if(cw.xAxis&&cw.processedYData){L=cw.processedXData;cy=cw.processedYData;cx=cy.length;for(;M<cx;M++){if(typeof cy[M]===aB&&L[M]>=cw.xAxis.min){cw.compareValue=cy[M];break}}}};bc(cc,"getExtremes",function(L){L.call(this);if(this.modifyValue){this.dataMax=this.modifyValue(this.dataMax);this.dataMin=this.modifyValue(this.dataMin)}});C.prototype.setCompare=function(L,M){if(!this.isXAxis){I(this.series,function(cw){cw.setCompare(L)});if(a0(M,true)){this.chart.redraw()}}};bU.prototype.tooltipFormatter=function(M){var L=this;M=M.replace("{point.change}",(L.change>0?"+":"")+m(L.change,a0(L.series.tooltipOptions.changeDecimals,2)));return bZ.apply(this,[M])};bD(aZ,{Axis:C,Chart:bB,Color:b6,Point:bU,Tick:aJ,Renderer:cf,Series:bq,SVGElement:aH,SVGRenderer:d,arrayMin:bY,arrayMax:aS,charts:aO,dateFormat:cb,format:g,pathAnim:az,getOptions:aN,hasBidiBug:ak,isTouchDevice:ba,numberFormat:m,seriesTypes:a,setOptions:bl,addEvent:z,removeEvent:bh,createElement:bF,discardElement:ca,css:cp,each:I,extend:bD,map:ar,merge:aY,pick:a0,splat:bw,extendClass:bA,pInt:b8,wrap:bc,svg:cl,canvas:bj,vml:!cl&&!bj,product:bX,version:cj})}());
/*global define:false */
/**
 * Copyright 2013 Craig Campbell
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Mousetrap is a simple keyboard shortcut library for Javascript with
 * no external dependencies
 *
 * @version 1.4.6
 * @url craig.is/killing/mice
 */

(function(window, document, undefined) {

    /**
     * mapping of special keycodes to their corresponding keys
     *
     * everything in this dictionary cannot use keypress events
     * so it has to be here to map to the correct keycodes for
     * keyup/keydown events
     *
     * @type {Object}
     */
    var _MAP = {
            8: 'backspace',
            9: 'tab',
            13: 'enter',
            16: 'shift',
            17: 'ctrl',
            18: 'alt',
            20: 'capslock',
            27: 'esc',
            32: 'space',
            33: 'pageup',
            34: 'pagedown',
            35: 'end',
            36: 'home',
            37: 'left',
            38: 'up',
            39: 'right',
            40: 'down',
            45: 'ins',
            46: 'del',
            91: 'meta',
            93: 'meta',
            224: 'meta'
        },

        /**
         * mapping for special characters so they can support
         *
         * this dictionary is only used incase you want to bind a
         * keyup or keydown event to one of these keys
         *
         * @type {Object}
         */
        _KEYCODE_MAP = {
            106: '*',
            107: '+',
            109: '-',
            110: '.',
            111 : '/',
            186: ';',
            187: '=',
            188: ',',
            189: '-',
            190: '.',
            191: '/',
            192: '`',
            219: '[',
            220: '\\',
            221: ']',
            222: '\''
        },

        /**
         * this is a mapping of keys that require shift on a US keypad
         * back to the non shift equivelents
         *
         * this is so you can use keyup events with these keys
         *
         * note that this will only work reliably on US keyboards
         *
         * @type {Object}
         */
        _SHIFT_MAP = {
            '~': '`',
            '!': '1',
            '@': '2',
            '#': '3',
            '$': '4',
            '%': '5',
            '^': '6',
            '&': '7',
            '*': '8',
            '(': '9',
            ')': '0',
            '_': '-',
            '+': '=',
            ':': ';',
            '\"': '\'',
            '<': ',',
            '>': '.',
            '?': '/',
            '|': '\\'
        },

        /**
         * this is a list of special strings you can use to map
         * to modifier keys when you specify your keyboard shortcuts
         *
         * @type {Object}
         */
        _SPECIAL_ALIASES = {
            'option': 'alt',
            'command': 'meta',
            'return': 'enter',
            'escape': 'esc',
            'mod': /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? 'meta' : 'ctrl'
        },

        /**
         * variable to store the flipped version of _MAP from above
         * needed to check if we should use keypress or not when no action
         * is specified
         *
         * @type {Object|undefined}
         */
        _REVERSE_MAP,

        /**
         * a list of all the callbacks setup via Mousetrap.bind()
         *
         * @type {Object}
         */
        _callbacks = {},

        /**
         * direct map of string combinations to callbacks used for trigger()
         *
         * @type {Object}
         */
        _directMap = {},

        /**
         * keeps track of what level each sequence is at since multiple
         * sequences can start out with the same sequence
         *
         * @type {Object}
         */
        _sequenceLevels = {},

        /**
         * variable to store the setTimeout call
         *
         * @type {null|number}
         */
        _resetTimer,

        /**
         * temporary state where we will ignore the next keyup
         *
         * @type {boolean|string}
         */
        _ignoreNextKeyup = false,

        /**
         * temporary state where we will ignore the next keypress
         *
         * @type {boolean}
         */
        _ignoreNextKeypress = false,

        /**
         * are we currently inside of a sequence?
         * type of action ("keyup" or "keydown" or "keypress") or false
         *
         * @type {boolean|string}
         */
        _nextExpectedAction = false;

    /**
     * loop through the f keys, f1 to f19 and add them to the map
     * programatically
     */
    for (var i = 1; i < 20; ++i) {
        _MAP[111 + i] = 'f' + i;
    }

    /**
     * loop through to map numbers on the numeric keypad
     */
    for (i = 0; i <= 9; ++i) {
        _MAP[i + 96] = i;
    }

    /**
     * cross browser add event method
     *
     * @param {Element|HTMLDocument} object
     * @param {string} type
     * @param {Function} callback
     * @returns void
     */
    function _addEvent(object, type, callback) {
        if (object.addEventListener) {
            object.addEventListener(type, callback, false);
            return;
        }

        object.attachEvent('on' + type, callback);
    }

    /**
     * takes the event and returns the key character
     *
     * @param {Event} e
     * @return {string}
     */
    function _characterFromEvent(e) {

        // for keypress events we should return the character as is
        if (e.type == 'keypress') {
            var character = String.fromCharCode(e.which);

            // if the shift key is not pressed then it is safe to assume
            // that we want the character to be lowercase.  this means if
            // you accidentally have caps lock on then your key bindings
            // will continue to work
            //
            // the only side effect that might not be desired is if you
            // bind something like 'A' cause you want to trigger an
            // event when capital A is pressed caps lock will no longer
            // trigger the event.  shift+a will though.
            if (!e.shiftKey) {
                character = character.toLowerCase();
            }

            return character;
        }

        // for non keypress events the special maps are needed
        if (_MAP[e.which]) {
            return _MAP[e.which];
        }

        if (_KEYCODE_MAP[e.which]) {
            return _KEYCODE_MAP[e.which];
        }

        // if it is not in the special map

        // with keydown and keyup events the character seems to always
        // come in as an uppercase character whether you are pressing shift
        // or not.  we should make sure it is always lowercase for comparisons
        return String.fromCharCode(e.which).toLowerCase();
    }

    /**
     * checks if two arrays are equal
     *
     * @param {Array} modifiers1
     * @param {Array} modifiers2
     * @returns {boolean}
     */
    function _modifiersMatch(modifiers1, modifiers2) {
        return modifiers1.sort().join(',') === modifiers2.sort().join(',');
    }

    /**
     * resets all sequence counters except for the ones passed in
     *
     * @param {Object} doNotReset
     * @returns void
     */
    function _resetSequences(doNotReset) {
        doNotReset = doNotReset || {};

        var activeSequences = false,
            key;

        for (key in _sequenceLevels) {
            if (doNotReset[key]) {
                activeSequences = true;
                continue;
            }
            _sequenceLevels[key] = 0;
        }

        if (!activeSequences) {
            _nextExpectedAction = false;
        }
    }

    /**
     * finds all callbacks that match based on the keycode, modifiers,
     * and action
     *
     * @param {string} character
     * @param {Array} modifiers
     * @param {Event|Object} e
     * @param {string=} sequenceName - name of the sequence we are looking for
     * @param {string=} combination
     * @param {number=} level
     * @returns {Array}
     */
    function _getMatches(character, modifiers, e, sequenceName, combination, level) {
        var i,
            callback,
            matches = [],
            action = e.type;

        // if there are no events related to this keycode
        if (!_callbacks[character]) {
            return [];
        }

        // if a modifier key is coming up on its own we should allow it
        if (action == 'keyup' && _isModifier(character)) {
            modifiers = [character];
        }

        // loop through all callbacks for the key that was pressed
        // and see if any of them match
        for (i = 0; i < _callbacks[character].length; ++i) {
            callback = _callbacks[character][i];

            // if a sequence name is not specified, but this is a sequence at
            // the wrong level then move onto the next match
            if (!sequenceName && callback.seq && _sequenceLevels[callback.seq] != callback.level) {
                continue;
            }

            // if the action we are looking for doesn't match the action we got
            // then we should keep going
            if (action != callback.action) {
                continue;
            }

            // if this is a keypress event and the meta key and control key
            // are not pressed that means that we need to only look at the
            // character, otherwise check the modifiers as well
            //
            // chrome will not fire a keypress if meta or control is down
            // safari will fire a keypress if meta or meta+shift is down
            // firefox will fire a keypress if meta or control is down
            if ((action == 'keypress' && !e.metaKey && !e.ctrlKey) || _modifiersMatch(modifiers, callback.modifiers)) {

                // when you bind a combination or sequence a second time it
                // should overwrite the first one.  if a sequenceName or
                // combination is specified in this call it does just that
                //
                // @todo make deleting its own method?
                var deleteCombo = !sequenceName && callback.combo == combination;
                var deleteSequence = sequenceName && callback.seq == sequenceName && callback.level == level;
                if (deleteCombo || deleteSequence) {
                    _callbacks[character].splice(i, 1);
                }

                matches.push(callback);
            }
        }

        return matches;
    }

    /**
     * takes a key event and figures out what the modifiers are
     *
     * @param {Event} e
     * @returns {Array}
     */
    function _eventModifiers(e) {
        var modifiers = [];

        if (e.shiftKey) {
            modifiers.push('shift');
        }

        if (e.altKey) {
            modifiers.push('alt');
        }

        if (e.ctrlKey) {
            modifiers.push('ctrl');
        }

        if (e.metaKey) {
            modifiers.push('meta');
        }

        return modifiers;
    }

    /**
     * prevents default for this event
     *
     * @param {Event} e
     * @returns void
     */
    function _preventDefault(e) {
        if (e.preventDefault) {
            e.preventDefault();
            return;
        }

        e.returnValue = false;
    }

    /**
     * stops propogation for this event
     *
     * @param {Event} e
     * @returns void
     */
    function _stopPropagation(e) {
        if (e.stopPropagation) {
            e.stopPropagation();
            return;
        }

        e.cancelBubble = true;
    }

    /**
     * actually calls the callback function
     *
     * if your callback function returns false this will use the jquery
     * convention - prevent default and stop propogation on the event
     *
     * @param {Function} callback
     * @param {Event} e
     * @returns void
     */
    function _fireCallback(callback, e, combo, sequence) {

        // if this event should not happen stop here
        if (Mousetrap.stopCallback(e, e.target || e.srcElement, combo, sequence)) {
            return;
        }

        if (callback(e, combo) === false) {
            _preventDefault(e);
            _stopPropagation(e);
        }
    }

    /**
     * handles a character key event
     *
     * @param {string} character
     * @param {Array} modifiers
     * @param {Event} e
     * @returns void
     */
    function _handleKey(character, modifiers, e) {
        var callbacks = _getMatches(character, modifiers, e),
            i,
            doNotReset = {},
            maxLevel = 0,
            processedSequenceCallback = false;

        // Calculate the maxLevel for sequences so we can only execute the longest callback sequence
        for (i = 0; i < callbacks.length; ++i) {
            if (callbacks[i].seq) {
                maxLevel = Math.max(maxLevel, callbacks[i].level);
            }
        }

        // loop through matching callbacks for this key event
        for (i = 0; i < callbacks.length; ++i) {

            // fire for all sequence callbacks
            // this is because if for example you have multiple sequences
            // bound such as "g i" and "g t" they both need to fire the
            // callback for matching g cause otherwise you can only ever
            // match the first one
            if (callbacks[i].seq) {

                // only fire callbacks for the maxLevel to prevent
                // subsequences from also firing
                //
                // for example 'a option b' should not cause 'option b' to fire
                // even though 'option b' is part of the other sequence
                //
                // any sequences that do not match here will be discarded
                // below by the _resetSequences call
                if (callbacks[i].level != maxLevel) {
                    continue;
                }

                processedSequenceCallback = true;

                // keep a list of which sequences were matches for later
                doNotReset[callbacks[i].seq] = 1;
                _fireCallback(callbacks[i].callback, e, callbacks[i].combo, callbacks[i].seq);
                continue;
            }

            // if there were no sequence matches but we are still here
            // that means this is a regular match so we should fire that
            if (!processedSequenceCallback) {
                _fireCallback(callbacks[i].callback, e, callbacks[i].combo);
            }
        }

        // if the key you pressed matches the type of sequence without
        // being a modifier (ie "keyup" or "keypress") then we should
        // reset all sequences that were not matched by this event
        //
        // this is so, for example, if you have the sequence "h a t" and you
        // type "h e a r t" it does not match.  in this case the "e" will
        // cause the sequence to reset
        //
        // modifier keys are ignored because you can have a sequence
        // that contains modifiers such as "enter ctrl+space" and in most
        // cases the modifier key will be pressed before the next key
        //
        // also if you have a sequence such as "ctrl+b a" then pressing the
        // "b" key will trigger a "keypress" and a "keydown"
        //
        // the "keydown" is expected when there is a modifier, but the
        // "keypress" ends up matching the _nextExpectedAction since it occurs
        // after and that causes the sequence to reset
        //
        // we ignore keypresses in a sequence that directly follow a keydown
        // for the same character
        var ignoreThisKeypress = e.type == 'keypress' && _ignoreNextKeypress;
        if (e.type == _nextExpectedAction && !_isModifier(character) && !ignoreThisKeypress) {
            _resetSequences(doNotReset);
        }

        _ignoreNextKeypress = processedSequenceCallback && e.type == 'keydown';
    }

    /**
     * handles a keydown event
     *
     * @param {Event} e
     * @returns void
     */
    function _handleKeyEvent(e) {

        // normalize e.which for key events
        // @see http://stackoverflow.com/questions/4285627/javascript-keycode-vs-charcode-utter-confusion
        if (typeof e.which !== 'number') {
            e.which = e.keyCode;
        }

        var character = _characterFromEvent(e);

        // no character found then stop
        if (!character) {
            return;
        }

        // need to use === for the character check because the character can be 0
        if (e.type == 'keyup' && _ignoreNextKeyup === character) {
            _ignoreNextKeyup = false;
            return;
        }

        Mousetrap.handleKey(character, _eventModifiers(e), e);
    }

    /**
     * determines if the keycode specified is a modifier key or not
     *
     * @param {string} key
     * @returns {boolean}
     */
    function _isModifier(key) {
        return key == 'shift' || key == 'ctrl' || key == 'alt' || key == 'meta';
    }

    /**
     * called to set a 1 second timeout on the specified sequence
     *
     * this is so after each key press in the sequence you have 1 second
     * to press the next key before you have to start over
     *
     * @returns void
     */
    function _resetSequenceTimer() {
        clearTimeout(_resetTimer);
        _resetTimer = setTimeout(_resetSequences, 1000);
    }

    /**
     * reverses the map lookup so that we can look for specific keys
     * to see what can and can't use keypress
     *
     * @return {Object}
     */
    function _getReverseMap() {
        if (!_REVERSE_MAP) {
            _REVERSE_MAP = {};
            for (var key in _MAP) {

                // pull out the numeric keypad from here cause keypress should
                // be able to detect the keys from the character
                if (key > 95 && key < 112) {
                    continue;
                }

                if (_MAP.hasOwnProperty(key)) {
                    _REVERSE_MAP[_MAP[key]] = key;
                }
            }
        }
        return _REVERSE_MAP;
    }

    /**
     * picks the best action based on the key combination
     *
     * @param {string} key - character for key
     * @param {Array} modifiers
     * @param {string=} action passed in
     */
    function _pickBestAction(key, modifiers, action) {

        // if no action was picked in we should try to pick the one
        // that we think would work best for this key
        if (!action) {
            action = _getReverseMap()[key] ? 'keydown' : 'keypress';
        }

        // modifier keys don't work as expected with keypress,
        // switch to keydown
        if (action == 'keypress' && modifiers.length) {
            action = 'keydown';
        }

        return action;
    }

    /**
     * binds a key sequence to an event
     *
     * @param {string} combo - combo specified in bind call
     * @param {Array} keys
     * @param {Function} callback
     * @param {string=} action
     * @returns void
     */
    function _bindSequence(combo, keys, callback, action) {

        // start off by adding a sequence level record for this combination
        // and setting the level to 0
        _sequenceLevels[combo] = 0;

        /**
         * callback to increase the sequence level for this sequence and reset
         * all other sequences that were active
         *
         * @param {string} nextAction
         * @returns {Function}
         */
        function _increaseSequence(nextAction) {
            return function() {
                _nextExpectedAction = nextAction;
                ++_sequenceLevels[combo];
                _resetSequenceTimer();
            };
        }

        /**
         * wraps the specified callback inside of another function in order
         * to reset all sequence counters as soon as this sequence is done
         *
         * @param {Event} e
         * @returns void
         */
        function _callbackAndReset(e) {
            _fireCallback(callback, e, combo);

            // we should ignore the next key up if the action is key down
            // or keypress.  this is so if you finish a sequence and
            // release the key the final key will not trigger a keyup
            if (action !== 'keyup') {
                _ignoreNextKeyup = _characterFromEvent(e);
            }

            // weird race condition if a sequence ends with the key
            // another sequence begins with
            setTimeout(_resetSequences, 10);
        }

        // loop through keys one at a time and bind the appropriate callback
        // function.  for any key leading up to the final one it should
        // increase the sequence. after the final, it should reset all sequences
        //
        // if an action is specified in the original bind call then that will
        // be used throughout.  otherwise we will pass the action that the
        // next key in the sequence should match.  this allows a sequence
        // to mix and match keypress and keydown events depending on which
        // ones are better suited to the key provided
        for (var i = 0; i < keys.length; ++i) {
            var isFinal = i + 1 === keys.length;
            var wrappedCallback = isFinal ? _callbackAndReset : _increaseSequence(action || _getKeyInfo(keys[i + 1]).action);
            _bindSingle(keys[i], wrappedCallback, action, combo, i);
        }
    }

    /**
     * Converts from a string key combination to an array
     *
     * @param  {string} combination like "command+shift+l"
     * @return {Array}
     */
    function _keysFromString(combination) {
        if (combination === '+') {
            return ['+'];
        }

        return combination.split('+');
    }

    /**
     * Gets info for a specific key combination
     *
     * @param  {string} combination key combination ("command+s" or "a" or "*")
     * @param  {string=} action
     * @returns {Object}
     */
    function _getKeyInfo(combination, action) {
        var keys,
            key,
            i,
            modifiers = [];

        // take the keys from this pattern and figure out what the actual
        // pattern is all about
        keys = _keysFromString(combination);

        for (i = 0; i < keys.length; ++i) {
            key = keys[i];

            // normalize key names
            if (_SPECIAL_ALIASES[key]) {
                key = _SPECIAL_ALIASES[key];
            }

            // if this is not a keypress event then we should
            // be smart about using shift keys
            // this will only work for US keyboards however
            if (action && action != 'keypress' && _SHIFT_MAP[key]) {
                key = _SHIFT_MAP[key];
                modifiers.push('shift');
            }

            // if this key is a modifier then add it to the list of modifiers
            if (_isModifier(key)) {
                modifiers.push(key);
            }
        }

        // depending on what the key combination is
        // we will try to pick the best event for it
        action = _pickBestAction(key, modifiers, action);

        return {
            key: key,
            modifiers: modifiers,
            action: action
        };
    }

    /**
     * binds a single keyboard combination
     *
     * @param {string} combination
     * @param {Function} callback
     * @param {string=} action
     * @param {string=} sequenceName - name of sequence if part of sequence
     * @param {number=} level - what part of the sequence the command is
     * @returns void
     */
    function _bindSingle(combination, callback, action, sequenceName, level) {

        // store a direct mapped reference for use with Mousetrap.trigger
        _directMap[combination + ':' + action] = callback;

        // make sure multiple spaces in a row become a single space
        combination = combination.replace(/\s+/g, ' ');

        var sequence = combination.split(' '),
            info;

        // if this pattern is a sequence of keys then run through this method
        // to reprocess each pattern one key at a time
        if (sequence.length > 1) {
            _bindSequence(combination, sequence, callback, action);
            return;
        }

        info = _getKeyInfo(combination, action);

        // make sure to initialize array if this is the first time
        // a callback is added for this key
        _callbacks[info.key] = _callbacks[info.key] || [];

        // remove an existing match if there is one
        _getMatches(info.key, info.modifiers, {type: info.action}, sequenceName, combination, level);

        // add this call back to the array
        // if it is a sequence put it at the beginning
        // if not put it at the end
        //
        // this is important because the way these are processed expects
        // the sequence ones to come first
        _callbacks[info.key][sequenceName ? 'unshift' : 'push']({
            callback: callback,
            modifiers: info.modifiers,
            action: info.action,
            seq: sequenceName,
            level: level,
            combo: combination
        });
    }

    /**
     * binds multiple combinations to the same callback
     *
     * @param {Array} combinations
     * @param {Function} callback
     * @param {string|undefined} action
     * @returns void
     */
    function _bindMultiple(combinations, callback, action) {
        for (var i = 0; i < combinations.length; ++i) {
            _bindSingle(combinations[i], callback, action);
        }
    }

    // start!
    _addEvent(document, 'keypress', _handleKeyEvent);
    _addEvent(document, 'keydown', _handleKeyEvent);
    _addEvent(document, 'keyup', _handleKeyEvent);

    var Mousetrap = {

        /**
         * binds an event to mousetrap
         *
         * can be a single key, a combination of keys separated with +,
         * an array of keys, or a sequence of keys separated by spaces
         *
         * be sure to list the modifier keys first to make sure that the
         * correct key ends up getting bound (the last key in the pattern)
         *
         * @param {string|Array} keys
         * @param {Function} callback
         * @param {string=} action - 'keypress', 'keydown', or 'keyup'
         * @returns void
         */
        bind: function(keys, callback, action) {
            keys = keys instanceof Array ? keys : [keys];
            _bindMultiple(keys, callback, action);
            return this;
        },

        /**
         * unbinds an event to mousetrap
         *
         * the unbinding sets the callback function of the specified key combo
         * to an empty function and deletes the corresponding key in the
         * _directMap dict.
         *
         * TODO: actually remove this from the _callbacks dictionary instead
         * of binding an empty function
         *
         * the keycombo+action has to be exactly the same as
         * it was defined in the bind method
         *
         * @param {string|Array} keys
         * @param {string} action
         * @returns void
         */
        unbind: function(keys, action) {
            return Mousetrap.bind(keys, function() {}, action);
        },

        /**
         * triggers an event that has already been bound
         *
         * @param {string} keys
         * @param {string=} action
         * @returns void
         */
        trigger: function(keys, action) {
            if (_directMap[keys + ':' + action]) {
                _directMap[keys + ':' + action]({}, keys);
            }
            return this;
        },

        /**
         * resets the library back to its initial state.  this is useful
         * if you want to clear out the current keyboard shortcuts and bind
         * new ones - for example if you switch to another page
         *
         * @returns void
         */
        reset: function() {
            _callbacks = {};
            _directMap = {};
            return this;
        },

       /**
        * should we stop this event before firing off callbacks
        *
        * @param {Event} e
        * @param {Element} element
        * @return {boolean}
        */
        stopCallback: function(e, element) {

            // if the element has the class "mousetrap" then no need to stop
            if ((' ' + element.className + ' ').indexOf(' mousetrap ') > -1) {
                return false;
            }

            // stop for input, select, and textarea
            return element.tagName == 'INPUT' || element.tagName == 'SELECT' || element.tagName == 'TEXTAREA' || element.isContentEditable;
        },

        /**
         * exposes _handleKey publicly so it can be overwritten by extensions
         */
        handleKey: _handleKey
    };

    // expose mousetrap to the global object
    window.Mousetrap = Mousetrap;

    // expose mousetrap as an AMD module
    if (typeof define === 'function' && define.amd) {
        define(Mousetrap);
    }
}) (window, document);
/**
 * adds a bindGlobal method to Mousetrap that allows you to
 * bind specific keyboard shortcuts that will still work
 * inside a text input field
 *
 * usage:
 * Mousetrap.bindGlobal('ctrl+s', _saveChanges);
 */
/* global Mousetrap:true */

Mousetrap = (function(Mousetrap) {
    var _globalCallbacks = {},
        _originalStopCallback = Mousetrap.stopCallback;

    Mousetrap.stopCallback = function(e, element, combo, sequence) {
        if (_globalCallbacks[combo] || _globalCallbacks[sequence]) {
            return false;
        }

        return _originalStopCallback(e, element, combo);
    };

    Mousetrap.bindGlobal = function(keys, callback, action) {
        Mousetrap.bind(keys, callback, action);

        if (keys instanceof Array) {
            for (var i = 0; i < keys.length; i++) {
                _globalCallbacks[keys[i]] = true;
            }
            return;
        }

        _globalCallbacks[keys] = true;
    };

    return Mousetrap;
}) (Mousetrap);
// This is a manifest file that'll be compiled into application.js, which will include all the files
// listed below.
//
// Any JavaScript/Coffee file within this directory, lib/assets/javascripts, vendor/assets/javascripts,
// or vendor/assets/javascripts of plugins, if any, can be referenced here using a relative path.
//
// It's not advisable to add code directly here, but if you do, it'll appear at the bottom of the
// the compiled file.
//
// WARNING: THE FIRST BLANK LINE MARKS THE END OF WHAT'S TO BE PROCESSED, ANY BLANK LINE SHOULD
// GO AFTER THE REQUIRES BELOW.
//










;

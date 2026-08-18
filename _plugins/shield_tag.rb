# frozen_string_literal: true

module Jekyll
  class ShieldTag < Liquid::Block
    def render(context)
      content = super

      <<~HTML
        <!-- shield-on -->
        <div class="tk9">
        #{content}
        </div>
        <!-- shield-off -->
      HTML
    end
  end
end

Liquid::Template.register_tag('shield', Jekyll::ShieldTag)
